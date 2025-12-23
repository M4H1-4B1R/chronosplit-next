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
  Avatar,
  ButtonGroup
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
          customer: "Customer",
          date: new Date(order.createdAt).toLocaleDateString()
        });
      }
    });
  }

  return {
    locations: shopifyLocations,
    savedLocationId,
    heldOrders,
    shopDomain: session.shop
  };
};

// Save, release all, or release selected
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

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

  // Fetch current held orders to process releases
  if (intent === "release_all" || intent === "release_selected") {
    const targetLocationId = formData.get("locationId");

    // Parse selected IDs if selected
    let selectedOrderIds = [];
    if (intent === "release_selected") {
      const jsonIds = formData.get("selectedOrderIds");
      selectedOrderIds = JSON.parse(jsonIds);
    }

    // Fetch unfulfilled orders
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
      // If only want to release selected orders & skip orders not in our list
      if (intent === "release_selected" && !selectedOrderIds.includes(order.id)) {
        return;
      }

      order.fulfillmentOrders.nodes.forEach(fo => {
        if (fo.assignedLocation.location?.id === targetLocationId && fo.status === 'ON_HOLD') {
          idsToRelease.push(fo.id);
          orderIdsToClean.add(order.id);
        }
      });
    });

    if (idsToRelease.length === 0) {
      return { status: "info", message: "No matching held orders found to release." };
    }

    // Release holds
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

// UI components
export default function Index() {
  const { locations, savedLocationId, heldOrders, shopDomain } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const nav = useNavigation();

  const [selectedLocation, setSelectedLocation] = useState(savedLocationId);
  const [selectedItems, setSelectedItems] = useState([]); // State for checkboxes

  const isLoading = nav.state === "submitting";

  useEffect(() => {
    setSelectedLocation(savedLocationId);
  }, [savedLocationId]);

  // Clear selection after a successful action
  useEffect(() => {
    if (actionData?.status === "success") {
      setSelectedItems([]);
    }
  }, [actionData]);

  const handleSave = () => {
    const formData = new FormData();
    formData.append("intent", "save");
    formData.append("locationId", selectedLocation);
    submit(formData, { method: "POST" });
  };

  const handleReleaseAll = () => {
    const formData = new FormData();
    formData.append("intent", "release_all");
    formData.append("locationId", selectedLocation);
    submit(formData, { method: "POST" });
  };

  const handleReleaseSelected = () => {
    const formData = new FormData();
    formData.append("intent", "release_selected");
    formData.append("locationId", selectedLocation);
    // Send the list of IDs as a string
    formData.append("selectedOrderIds", JSON.stringify(selectedItems));
    submit(formData, { method: "POST" });
  };

  return (
    <Page title="Chrono Split Dashboard">
      <BlockStack gap="500">

        {actionData?.message && (
          <Banner tone={actionData.status === "success" ? "success" : "info"}>
            {actionData.message}
          </Banner>
        )}

        {/* Section 1: Configuration */}
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
                  options={[{ label: "Select...", value: "" }, ...locations.map(l => ({ label: l.name, value: l.id }))]}
                  onChange={setSelectedLocation}
                  value={selectedLocation}
                />
                <Box>
                  <Button variant="primary" onClick={handleSave} loading={isLoading && nav.formData?.get("intent") === "save"}>
                    Save Settings
                  </Button>
                </Box>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* Section 2: Operations */}
          {selectedLocation && (
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
                    <Card padding="0">
                      {/* SELECTABLE RESOURCE LIST */}
                      <ResourceList
                        resourceName={{ singular: 'order', plural: 'orders' }}
                        items={heldOrders}
                        selectedItems={selectedItems}
                        onSelectionChange={setSelectedItems}
                        selectable
                        renderItem={(item) => {
                          const { id, name, customer, date } = item;
                          const orderId = id.split('/').pop();
                          const orderUrl = `https://${shopDomain}/admin/orders/${orderId}`;

                          return (
                            <ResourceItem
                              id={id}
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

                  {/* Button group */}
                  <Box>
                    <ButtonGroup>
                      {/* Release selected button */}
                      <Button
                        onClick={handleReleaseSelected}
                        disabled={selectedItems.length === 0} // Only active if items checked
                        loading={isLoading && nav.formData?.get("intent") === "release_selected"}
                      >
                        Release Selected ({selectedItems.length})
                      </Button>

                      {/* Release all button */}
                      <Button
                        variant="primary"
                        tone="critical"
                        onClick={handleReleaseAll}
                        disabled={heldOrders.length === 0}
                        loading={isLoading && nav.formData?.get("intent") === "release_all"}
                      >
                        Release All Holds
                      </Button>
                    </ButtonGroup>
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
