import { useEffect, useState, useCallback } from "react";
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
  ButtonGroup,
  TextField
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Loader: Fetch details for splitting
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

  // Held orders
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
              fulfillmentOrders(first: 10) {
                nodes {
                  id
                  status
                  assignedLocation { location { id } }
                  lineItems(first: 20) {
                    nodes {
                      id
                      remainingQuantity
                      lineItem {
                        title
                      }
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
      const heldFulfillment = order.fulfillmentOrders.nodes.find(fo =>
        fo.assignedLocation.location?.id === savedLocationId && fo.status === 'ON_HOLD'
      );

      if (heldFulfillment) {
        const itemNames = heldFulfillment.lineItems.nodes
          .map(node => node.lineItem?.title || "Unknown")
          .join(", ");

        heldOrders.push({
          id: order.id,
          name: order.name,
          customer: "Customer",
          date: new Date(order.createdAt).toLocaleDateString(),
          items: itemNames
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

// The "unlock -> split -> relock" logic
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
    const filterText = formData.get("filterText") || "";

    let targetOrderIds = [];
    if (intent === "release_selected") {
      targetOrderIds = JSON.parse(formData.get("selectedOrderIds"));
    } else if (intent === "release_all") {
      targetOrderIds = JSON.parse(formData.get("filteredOrderIds"));
    }

    console.log(`🚀 Starting Release. Filter: "${filterText}". Targets: ${targetOrderIds.length}`);

    const holdQuery = await admin.graphql(
      `#graphql
        query getHeldOrders($query: String!) {
          orders(first: 50, query: $query) {
            nodes {
              id
              name # Added name so logs work
              fulfillmentOrders(first: 5) {
                nodes {
                  id
                  status
                  assignedLocation { location { id } }
                  lineItems(first: 20) {
                    nodes {
                      id
                      remainingQuantity
                      lineItem { title }
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
    let releasedCount = 0;
    const ordersToCheckForTagRemoval = new Set();

    for (const order of holdData.data.orders.nodes) {
      if (!targetOrderIds.includes(order.id)) continue;

      const heldFulfillment = order.fulfillmentOrders.nodes.find(fo =>
        fo.assignedLocation.location?.id === targetLocationId && fo.status === 'ON_HOLD'
      );

      if (!heldFulfillment) continue;

      // 1. Identify matches
      const linesToRelease = heldFulfillment.lineItems.nodes.filter(lineNode => {
        if (!filterText) return true;
        const title = lineNode.lineItem?.title || "";
        return title.toLowerCase().includes(filterText.toLowerCase());
      });

      if (linesToRelease.length === 0) continue;

      const isPartialRelease = linesToRelease.length < heldFulfillment.lineItems.nodes.length;

      // === Partial release logic ===
      if (isPartialRelease) {
        console.log(`🪓 Order ${order.name}: Partial Release. Unlocking first...`);

        // Step 1: Unlock (release hold on the whole thing so we can split)
        await admin.graphql(
          `#graphql
              mutation releaseHold($id: ID!) {
                fulfillmentOrderReleaseHold(id: $id) { userErrors { message } }
              }
            `,
          { variables: { id: heldFulfillment.id } }
        );

        // Step 2: Split (move the released items into a new fulfillment order)
        console.log(`   -> Splitting ${linesToRelease.length} items out...`);
        const fulfillmentOrderLineItems = linesToRelease.map(line => ({
          id: line.id,
          quantity: line.remainingQuantity
        }));

        const splitResponse = await admin.graphql(
          `#graphql
            mutation fulfillmentOrderSplit($fulfillmentOrderSplits: [FulfillmentOrderSplitInput!]!) {
              fulfillmentOrderSplit(fulfillmentOrderSplits: $fulfillmentOrderSplits) {
                fulfillmentOrderSplits {
                    fulfillmentOrder { id }
                }
                userErrors { message }
              }
            }
          `,
          {
            variables: {
              fulfillmentOrderSplits: [
                {
                  fulfillmentOrderId: heldFulfillment.id,
                  fulfillmentOrderLineItems: fulfillmentOrderLineItems
                }
              ]
            }
          }
        );

        const splitJson = await splitResponse.json();

        if (splitJson.data.fulfillmentOrderSplit.userErrors.length > 0) {
          console.error("❌ Split Failed:", splitJson.data.fulfillmentOrderSplit.userErrors);
          // Emergency: Re-hold the original if split failed
          await admin.graphql(
            `#graphql
                  mutation hold($id: ID!, $hold: FulfillmentOrderHoldInput!) {
                    fulfillmentOrderHold(id: $id, fulfillmentHold: $hold) { userErrors { message } }
                  }
                `,
            { variables: { id: heldFulfillment.id, hold: { reason: "INVENTORY_OUT_OF_STOCK", reasonNotes: "Split failed, re-holding" } } }
          );
          continue;
        }

        // Step c: Relock (re-hold the the other fulfillment items)
        console.log(`   -> Re-locking remaining items (ID: ${heldFulfillment.id})...`);
        await admin.graphql(
          `#graphql
              mutation hold($id: ID!, $hold: FulfillmentOrderHoldInput!) {
                fulfillmentOrderHold(id: $id, fulfillmentHold: $hold) { userErrors { message } }
              }
            `,
          {
            variables: {
              id: heldFulfillment.id,
              hold: { reason: "INVENTORY_OUT_OF_STOCK", reasonNotes: "Automatic Hold: Pre-Sale Remaining Items" }
            }
          }
        );

        // Success: The new fulfillment order created by split is released.
        releasedCount++;
        ordersToCheckForTagRemoval.add(order.id);

      } else {
        // === Full release logic ===
        console.log(`🔓 Order ${order.name}: Full Release.`);
        await admin.graphql(
          `#graphql
              mutation releaseHold($id: ID!) {
                fulfillmentOrderReleaseHold(id: $id) { userErrors { message } }
              }
            `,
          { variables: { id: heldFulfillment.id } }
        );
        releasedCount++;
        ordersToCheckForTagRemoval.add(order.id);
      }
    }

    // Cleanup tags
    for (const orderId of ordersToCheckForTagRemoval) {
      const checkQuery = await admin.graphql(
        `#graphql
          query checkStatus($id: ID!) {
            order(id: $id) {
              fulfillmentOrders(first: 10) {
                nodes {
                  status
                  assignedLocation { location { id } }
                }
              }
            }
          }
        `,
        { variables: { id: orderId } }
      );
      const checkData = await checkQuery.json();

      const remainingHolds = checkData.data.order.fulfillmentOrders.nodes.some(fo =>
        fo.assignedLocation.location?.id === targetLocationId && fo.status === 'ON_HOLD'
      );

      if (!remainingHolds) {
        await admin.graphql(
          `#graphql
            mutation tagsRemove($id: ID!, $tags: [String!]!) {
              tagsRemove(id: $id, tags: $tags) { userErrors { message } }
            }
          `,
          { variables: { id: orderId, tags: ["⚠️ Pre-Sale Hold"] } }
        );
      }
    }

    return { status: "success", message: `Processed ${releasedCount} release actions.` };
  }
  return null;
};

// 3. UI components
export default function Index() {
  const { locations, savedLocationId, heldOrders, shopDomain } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const nav = useNavigation();

  const [selectedLocation, setSelectedLocation] = useState(savedLocationId);
  const [selectedItems, setSelectedItems] = useState([]);
  const [queryValue, setQueryValue] = useState("");

  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  useEffect(() => { setSelectedLocation(savedLocationId); }, [savedLocationId]);
  useEffect(() => { if (actionData?.status === "success") setSelectedItems([]); }, [actionData]);

  const filteredOrders = heldOrders.filter((order) => {
    if (!queryValue) return true;
    const searchString = `${order.name} ${order.items}`.toLowerCase();
    return searchString.includes(queryValue.toLowerCase());
  });

  const totalItems = filteredOrders.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  const isFirstPage = currentPage === 1;
  const isLastPage = currentPage === totalPages || totalPages === 0;

  const currentItems = filteredOrders.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  const isLoading = nav.state === "submitting";

  const handleSave = () => {
    const formData = new FormData();
    formData.append("intent", "save");
    formData.append("locationId", selectedLocation);
    submit(formData, { method: "POST" });
  };

  const handleReleaseSelected = () => {
    const formData = new FormData();
    formData.append("intent", "release_selected");
    formData.append("locationId", selectedLocation);
    formData.append("selectedOrderIds", JSON.stringify(selectedItems));
    formData.append("filterText", queryValue);
    submit(formData, { method: "POST" });
  };

  const handleReleaseFiltered = () => {
    const formData = new FormData();
    formData.append("intent", "release_all");
    formData.append("locationId", selectedLocation);
    const visibleIds = filteredOrders.map(o => o.id);
    formData.append("filteredOrderIds", JSON.stringify(visibleIds));
    formData.append("filterText", queryValue);
    submit(formData, { method: "POST" });
  };

  const handleQueryValueChange = useCallback((value) => {
    setQueryValue(value);
    setCurrentPage(1);
  }, []);

  const handleQueryClear = useCallback(() => {
    handleQueryValueChange("");
  }, [handleQueryValueChange]);

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
                    <Badge tone={filteredOrders.length > 0 ? "warning" : "success"}>
                      {filteredOrders.length > 0 ? `${filteredOrders.length} Found` : "All Clear"}
                    </Badge>
                  </InlineStack>

                  <div style={{ padding: '0px 0px 8px 0px' }}>
                    <TextField
                      clearButton
                      onClearButtonClick={handleQueryClear}
                      value={queryValue}
                      onChange={handleQueryValueChange}
                      autoComplete="off"
                      placeholder="Filter by Item (e.g. 'Snowboard') to Release Specific Items"
                      prefix={<Text variant="bodyMd">🔍</Text>}
                    />
                  </div>

                  {filteredOrders.length > 0 ? (
                    <Card padding="0">
                      <ResourceList
                        resourceName={{ singular: 'order', plural: 'orders' }}
                        items={currentItems}
                        selectedItems={selectedItems}
                        onSelectionChange={setSelectedItems}
                        selectable
                        pagination={{
                          hasNext: !isLastPage,
                          hasPrevious: !isFirstPage,
                          onNext: () => setCurrentPage(c => c + 1),
                          onPrevious: () => setCurrentPage(c => c - 1),
                          label: `Page ${currentPage} of ${totalPages}`
                        }}
                        renderItem={(item) => {
                          const { id, name, customer, date, items } = item;
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
                              <Text variant="bodySm" tone="subdued">Contains: {items}</Text>
                              <InlineStack gap="200">
                                <Text variant="bodySm">{customer}</Text>
                                <Text variant="bodySm">• {date}</Text>
                              </InlineStack>
                            </ResourceItem>
                          );
                        }}
                      />
                    </Card>
                  ) : (
                    <Text as="p" tone="subdued">No orders match your search.</Text>
                  )}

                  <Box>
                    <ButtonGroup>
                      <Button
                        onClick={handleReleaseSelected}
                        disabled={selectedItems.length === 0}
                        loading={isLoading && nav.formData?.get("intent") === "release_selected"}
                      >
                        {queryValue && selectedItems.length > 0 ? `Release '${queryValue}' in Selected` : `Release Selected`}
                      </Button>
                      <Button
                        variant="primary"
                        tone="critical"
                        onClick={handleReleaseFiltered}
                        disabled={filteredOrders.length === 0}
                        loading={isLoading && nav.formData?.get("intent") === "release_all"}
                      >
                        {queryValue ? `Release '${queryValue}' in All (${filteredOrders.length})` : `Release All Holds (${filteredOrders.length})`}
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
