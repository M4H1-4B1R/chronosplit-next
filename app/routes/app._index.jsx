import { useEffect, useState } from "react";
import { useActionData, useLoaderData, useSubmit, useNavigation } from "react-router";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  Select,
  Banner,
  Box,
  InlineStack,
  Badge,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Loader: fetch locations & count held orders
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Fetch locations
  const locResponse = await admin.graphql(
    `#graphql
      query {
        locations(first: 20) {
          nodes {
            id
            name
          }
        }
      }
    `
  );
  const locData = await locResponse.json();
  const shopifyLocations = locData.data.locations.nodes;

  // Get saved settings
  const config = await prisma.configuration.findUnique({
    where: { shop: session.shop },
  });
  const savedLocationId = config?.locationId || "";

  // Count on hold orders
  let heldCount = 0;

  if (savedLocationId) {
    // Fetch all unfulfilled orders
    const holdQuery = await admin.graphql(
      `#graphql
        query getHeldOrders($query: String!) {
          orders(first: 50, query: $query) {
            nodes {
              fulfillmentOrders(first: 5) {
                nodes {
                  id
                  status
                  assignedLocation {
                    location {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      `,
      {
        // Search for "unfulfilled" to catch everything that hasn't shipped
        variables: { query: "fulfillment_status:unfulfilled" }
      }
    );

    const holdData = await holdQuery.json();

    // Filter manually for ON_HOLD status at specific location
    holdData.data.orders.nodes.forEach(order => {
      order.fulfillmentOrders.nodes.forEach(fo => {
        if (fo.assignedLocation.location?.id === savedLocationId && fo.status === 'ON_HOLD') {
            heldCount++;
        }
      });
    });
  }

  return {
    locations: shopifyLocations,
    savedLocationId,
    heldCount
  };
};

// Save settings or release holds
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  console.log(`👉 Action triggered with intent: ${intent}`);

  // Case a: save settings
  if (intent === "save") {
    const selectedLocationId = formData.get("locationId");
    await prisma.configuration.upsert({
      where: { shop: session.shop },
      update: { locationId: selectedLocationId },
      create: { shop: session.shop, locationId: selectedLocationId },
    });
    return { status: "success", message: "Settings saved successfully!" };
  }

  // case b: release holds
  if (intent === "release") {
    const targetLocationId = formData.get("locationId");

    const holdQuery = await admin.graphql(
      `#graphql
        query getHeldOrders($query: String!) {
          orders(first: 50, query: $query) {
            nodes {
              fulfillmentOrders(first: 5) {
                nodes {
                  id
                  status
                  assignedLocation {
                    location {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { variables: { query: "fulfillment_status:unfulfilled" } }
    );

    const holdData = await holdQuery.json();
    const idsToRelease = [];

    holdData.data.orders.nodes.forEach(order => {
      order.fulfillmentOrders.nodes.forEach(fo => {
        if (fo.assignedLocation.location?.id === targetLocationId && fo.status === 'ON_HOLD') {
          idsToRelease.push(fo.id);
        }
      });
    });

    console.log(`🔓 Found ${idsToRelease.length} orders to release.`);

    if (idsToRelease.length === 0) {
      return { status: "info", message: "No matching held orders found." };
    }

    for (const id of idsToRelease) {
      console.log(`🚀 Releasing Hold ID: ${id}`);
      await admin.graphql(
        `#graphql
          mutation releaseHold($id: ID!) {
            fulfillmentOrderReleaseHold(id: $id) {
              userErrors {
                message
              }
            }
          }
        `,
        { variables: { id } }
      );
    }

    return { status: "success", message: `Released ${idsToRelease.length} orders!` };
  }

  return null;
};

// UI components
export default function Index() {
  const { locations, savedLocationId, heldCount } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const nav = useNavigation();

  const [selected, setSelected] = useState(savedLocationId);
  const isLoading = nav.state === "submitting";

  useEffect(() => {
    setSelected(savedLocationId);
  }, [savedLocationId]);

  const handleSave = () => {
    const formData = new FormData();
    formData.append("intent", "save");
    formData.append("locationId", selected);
    submit(formData, { method: "POST" });
  };

  const handleRelease = () => {
    const formData = new FormData();
    formData.append("intent", "release");
    formData.append("locationId", selected);
    submit(formData, { method: "POST" });
  };

  const currentLocationName = locations.find(l => l.id === selected)?.name || "Pre-Sale";

  return (
    <Page title="Chrono Split Dashboard">
      <BlockStack gap="500">

        {actionData?.message && (
          <Banner tone={actionData.status === "success" ? "success" : "info"}>
            {actionData.message}
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Configuration</Text>
                <Text as="p">
                  Select which warehouse contains your <b>Pre-Sale</b> inventory.
                  Orders from this location will be automatically held and tagged.
                </Text>
                <Select
                  label="Pre-Sale Location"
                  options={[{label: "Select...", value: ""}, ...locations.map(l => ({label: l.name, value: l.id}))]}
                  onChange={setSelected}
                  value={selected}
                />
                <Box>
                  <Button variant="primary" onClick={handleSave} loading={isLoading && nav.formData?.get("intent") === "save"}>
                    Save Settings
                  </Button>
                </Box>
              </BlockStack>
            </Card>
          </Layout.Section>

          {selected && (
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between">
                    <Text as="h2" variant="headingMd">Operations</Text>
                    {heldCount > 0 ? (
                        <Badge tone="warning">{heldCount} Orders On Hold</Badge>
                    ) : (
                        <Badge tone="success">All Clear</Badge>
                    )}
                  </InlineStack>

                  <Text as="p">
                    Ready to ship your pre-sale items from <b>{currentLocationName}</b>?
                    Click below to release the holds on all matching orders immediately.
                  </Text>

                  <Box>
                    <Button
                      variant="primary"
                      tone="critical"
                      onClick={handleRelease}
                      disabled={heldCount === 0}
                      loading={isLoading && nav.formData?.get("intent") === "release"}
                    >
                      Release {heldCount > 0 ? `All ${heldCount} Holds` : "All Holds"}
                    </Button>
                  </Box>
                </BlockStack>
              </Card>
            </Layout.Section>
          )}
        </Layout>
      </BlockStack>
    </Page>
  );
}
