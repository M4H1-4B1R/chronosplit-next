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

// Increased limit to 250 for better coverage
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Locations
  const locResponse = await admin.graphql(
    `#graphql
      query {
        locations(first: 20) { nodes { id name } }
      }
    `
  );
  const locData = await locResponse.json();
  const shopifyLocations = locData.data.locations.nodes;

  // Settings
  const config = await prisma.configuration.findUnique({
    where: { shop: session.shop },
  });
  const savedLocationId = config?.locationId || "";

  // Held orders (limited to 250)
  let heldOrders = [];

  if (savedLocationId) {
    const holdQuery = await admin.graphql(
      `#graphql
        query getHeldOrders($query: String!) {
          orders(first: 250, query: $query) {
            nodes {
              id
              name
              createdAt
              fulfillmentOrders(first: 5) {
                nodes {
                  id
                  status
                  assignedLocation { location { id } }
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

  if (intent === "save") {
    const selectedLocationId = formData.get("locationId");
    await prisma.configuration.upsert({
      where: { shop: session.shop },
      update: { locationId: selectedLocationId },
      create: { shop: session.shop, locationId: selectedLocationId },
    });
    return { status: "success", message: "Settings saved successfully!" };
  }

  if (intent === "release_all" || intent === "release_selected") {
    const targetLocationId = formData.get("locationId");
    let selectedOrderIds = [];
    if (intent === "release_selected") {
      selectedOrderIds = JSON.parse(formData.get("selectedOrderIds"));
    }

    const holdQuery = await admin.graphql(
      `#graphql
        query getHeldOrders($query: String!) {
          orders(first: 250, query: $query) {
            nodes {
              id
              fulfillmentOrders(first: 5) {
                nodes {
                  id
                  status
                  assignedLocation { location { id } }
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
      if (intent === "release_selected" && !selectedOrderIds.includes(order.id)) return;

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

    for (const id of idsToRelease) {
      await admin.graphql(`#graphql mutation releaseHold($id: ID!) { fulfillmentOrderReleaseHold(id: $id) { userErrors { message } } }`, { variables: { id } });
    }
    for (const orderId of orderIdsToClean) {
      await admin.graphql(`#graphql mutation tagsRemove($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`, { variables: { id: orderId, tags: ["⚠️ Pre-Sale Hold"] } });
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
  const [selectedItems, setSelectedItems] = useState([]);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10; // Items per page

  // Calculate standard pagination logic
  const totalItems = heldOrders.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  const isFirstPage = currentPage === 1;
  const isLastPage = currentPage === totalPages || totalPages === 0;

  // Get only the items for the current page
  const currentItems = heldOrders.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  const isLoading = nav.state === "submitting";

  useEffect(() => { setSelectedLocation(savedLocationId); }, [savedLocationId]);
  useEffect(() => { if (actionData?.status === "success") setSelectedItems([]); }, [actionData]);

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

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Configuration</Text>
                <Text as="p">Select Pre-Sale Location.</Text>
                <Select
                  label="Pre-Sale Location"
                  options={[{ label: "Select...", value: "" }, ...locations.map(l => ({ label: l.name, value: l.id }))]}
                  onChange={setSelectedLocation}
                  value={selectedLocation}
                />
                <Box>
                  <Button variant="primary" onClick={handleSave} loading={isLoading && nav.formData?.get("intent") === "save"}>Save Settings</Button>
                </Box>
              </BlockStack>
            </Card>
          </Layout.Section>

          {selectedLocation && (
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between">
                    <Text as="h2" variant="headingMd">Operations</Text>
                    <Badge tone={heldOrders.length > 0 ? "warning" : "success"}>
                      {heldOrders.length > 0 ? `${heldOrders.length} Orders On Hold` : "All Clear"}
                    </Badge>
                  </InlineStack>

                  {heldOrders.length > 0 ? (
                    <Card padding="0">
                      <ResourceList
                        resourceName={{ singular: 'order', plural: 'orders' }}
                        items={currentItems} // Pass ONLY current page items
                        selectedItems={selectedItems}
                        onSelectionChange={setSelectedItems}
                        selectable
                        // PAGINATION PROPS
                        pagination={{
                          hasNext: !isLastPage,
                          hasPrevious: !isFirstPage,
                          onNext: () => setCurrentPage(c => c + 1),
                          onPrevious: () => setCurrentPage(c => c - 1),
                          label: `Page ${currentPage} of ${totalPages}`
                        }}
                        renderItem={(item) => {
                          const { id, name, customer, date } = item;
                          const orderId = id.split('/').pop();
                          const orderUrl = `https://${shopDomain}/admin/orders/${orderId}`;
                          return (
                            <ResourceItem
                              id={id}
                              onClick={() => window.open(orderUrl, "_blank")}
                              accessibilityLabel={`View order ${name}`}
                              media={<Avatar customer size="medium" name={customer} />}
                            >
                              <Text variant="bodyMd" fontWeight="bold" as="h3">{name}</Text>
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
                    <ButtonGroup>
                      <Button
                        onClick={handleReleaseSelected}
                        disabled={selectedItems.length === 0}
                        loading={isLoading && nav.formData?.get("intent") === "release_selected"}
                      >
                        Release Selected ({selectedItems.length})
                      </Button>
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
