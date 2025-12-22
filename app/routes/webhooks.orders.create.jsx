import { authenticate } from "../shopify.server";
import prisma from "../db.server"; // Import DB to read settings

export const action = async ({ request }) => {
  const { topic, shop, session, admin, payload } = await authenticate.webhook(request);

  console.log("------------------------------------------------");
  console.log("🚀 WEBHOOK RECEIVED: " + topic);

  // Fetch the saved settings for this shop
  const config = await prisma.configuration.findUnique({
    where: { shop: shop },
  });

  if (!config || !config.locationId) {
    console.log("⚠️ No pre-sale location configured in settings. skipping.");
    return new Response();
  }

  const targetLocationId = config.locationId;
  console.log(`🎯 Target pre-sale location ID: ${targetLocationId}`);

  // Fetch order data
  const response = await admin.graphql(
    `#graphql
      query getFulfillmentData($id: ID!) {
        order(id: $id) {
          id
          fulfillmentOrders(first: 10) {
            nodes {
              id
              status
              assignedLocation {
                name
                location {
                  id
                }
              }
            }
          }
        }
      }
    `,
    { variables: { id: payload.admin_graphql_api_id } }
  );

  const { data } = await response.json();
  const fulfillmentOrders = data.order.fulfillmentOrders.nodes;
  const orderId = data.order.id;

  let holdApplied = false;

  // Loop through shipments
  for (const fo of fulfillmentOrders) {
    // Get the ID of the location this shipment is assigned to
    const shipmentLocationId = fo.assignedLocation.location?.id;

    console.log(`🔍 Checking shipment from: ${fo.assignedLocation.name} (ID: ${shipmentLocationId})`);

    // compare IDs: Does this shipment match the saved setting?
    if (shipmentLocationId === targetLocationId && fo.status === "OPEN") {

      console.log(`✋ MATCH FOUND! Placing Hold on Fulfillment ID: ${fo.id}`);

      // Place the hold
      const holdResponse = await admin.graphql(
        `#graphql
          mutation fulfillmentOrderHold($id: ID!, $fulfillmentHold: FulfillmentOrderHoldInput!) {
            fulfillmentOrderHold(id: $id, fulfillmentHold: $fulfillmentHold) {
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          variables: {
            id: fo.id,
            fulfillmentHold: {
              reason: "INVENTORY_OUT_OF_STOCK",
              reasonNotes: "Automatic Hold: Pre-Sale Item"
            }
          }
        }
      );

      const holdData = await holdResponse.json();

      if (holdData.data.fulfillmentOrderHold.userErrors.length > 0) {
        console.log("❌ Error holding order:", holdData.data.fulfillmentOrderHold.userErrors);
      } else {
        console.log("✅ SUCCESS: Pre-Sale Shipment is now ON HOLD.");
        holdApplied = true;
      }
    }
  }

  // Add a tag for better management
  if (holdApplied) {
    console.log("🏷️ Tagging Order...");
    const tagResponse = await admin.graphql(
      `#graphql
        mutation tagsAdd($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        variables: {
          id: orderId,
          tags: ["⚠️ Pre-Sale Hold"]
        }
      }
    );
  }

  console.log("------------------------------------------------");
  return new Response();
};
