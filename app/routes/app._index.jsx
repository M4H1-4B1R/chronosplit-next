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
  ResourceList,
  ResourceItem,
  Avatar
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Fetch locations, list held orders, and shop domain
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

  // Find on hold orders
  let heldOrders = [];

  if (savedLocationId) {
    const holdQuery = await admin.graphql(
      `#graphql
        query getHeldOrders($query: String!) {
          orders(first: 50, query: $query) {
            nodes {
              id
              name
              createdAt
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

    holdData.data.orders.nodes.forEach(order => {
      const isHeld = order.fulfillmentOrders.nodes.some(fo =>
        fo.assignedLocation.location?.id === savedLocationId && fo.status === 'ON_HOLD'
      );

      if (isHeld) {
        heldOrders.push({
          id: order.id,
          name: order.name,
          customer: "Customer", // Placeholder
          date: new Date(order.createdAt).toLocaleDateString()
        });
      }
    });
  }

  return {
    locations: shopifyLocations,
    savedLocationId,
    heldOrders,
    shopDomain: session.shop // Pass the shop domain to the frontend
  };
};

// Save settings or release holds
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  // Save settings
  if (intent === "save") {
    const selectedLocationId = formData.get("locationId");
    await prisma.configuration.upsert({
      where: { shop: session.shop },
      update: { locationId: selectedLocationId },
      create: { shop: session.shop, locationId: selectedLocationId },
    });
    return { status: "success", message: "Settings saved successfully!" };
  }

  // Release holds
  if (intent === "release") {
    const targetLocationId = formData.get("locationId");

    const holdQuery = await admin.graphql(
      `#graphql
        query getHeldOrders($query: String!) {
          orders(first: 50, query: $query) {
            nodes {
              id
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
    const orderIdsToClean = new Set();

    holdData.data.orders.nodes.forEach(order => {
      order.fulfillmentOrders.nodes.forEach(fo => {
        if (fo.assignedLocation.location?.id === targetLocationId && fo.status === 'ON_HOLD') {
          idsToRelease.push(fo.id);
          orderIdsToClean.add(order.id);
        }
      });
    });

    if (idsToRelease.length === 0) {
      return { status: "info", message: "No matching held orders found." };
    }

    // Release Holds
    for (const id of idsToRelease) {
      await admin.graphql(
        `#graphql
          mutation releaseHold($id: ID!) {
            fulfillmentOrderReleaseHold(id: $id) {
              userErrors { message }
            }
          }
        `,
        { variables: { id } }
      );
    }

    // Remove tags
    for (const orderId of orderIdsToClean) {
      await admin.graphql(
        `#graphql
          mutation tagsRemove($id: ID!, $tags: [String!]!) {
            tagsRemove(id: $id, tags: $tags) {
              userErrors { message }
            }
          }
        `,
        { variables: { id: orderId, tags: ["⚠️ Pre-Sale Hold"] } }
      );
    }

    return { status: "success", message: `Released ${idsToRelease.length} orders!` };
  }

  return null;
};

// UI component
export default function Index() {
  const { locations, savedLocationId, heldOrders, shopDomain } = useLoaderData();
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
                    {heldOrders.length > 0 ? (
                        <Badge tone="warning">{heldOrders.length} Orders On Hold</Badge>
                    ) : (
                        <Badge tone="success">All Clear</Badge>
                    )}
                  </InlineStack>

                  {heldOrders.length > 0 ? (
                    <Card>
                        <ResourceList
                            resourceName={{singular: 'order', plural: 'orders'}}
                            items={heldOrders}
                            renderItem={(item) => {
                                const {id, name, customer, date} = item;

                                // Extract ID
                                const orderId = id.split('/').pop();

                                // Build standard https url for new tab
                                // Note: use the shop domain passed from the loader
                                const orderUrl = `https://${shopDomain}/admin/orders/${orderId}`;

                                return (
                                    <ResourceItem
                                        id={id}
                                        // Open in new tab
                                        onClick={() => window.open(orderUrl, "_blank")}
                                        accessibilityLabel={`View order ${name}`}
                                        media={
                                            <Avatar customer size="medium" name={customer} />
                                        }
                                    >
                                        <Text variant="bodyMd" fontWeight="bold" as="h3">
                                            {name}
                                        </Text>
                                        <div>{customer}</div>
                                        <div>{date}</div>
                                    </ResourceItem>
                                );
                            }}
                        />
                    </Card>
                  ) : (
                    <Text as="p" tone="subdued">No orders are currently waiting in this location.</Text>
                  )}

                  <Box>
                    <Button
                      variant="primary"
                      tone="critical"
                      onClick={handleRelease}
                      disabled={heldOrders.length === 0}
                      loading={isLoading && nav.formData?.get("intent") === "release"}
                    >
                      Release {heldOrders.length > 0 ? `All ${heldOrders.length} Holds` : "All Holds"}
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
