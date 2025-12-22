import { useEffect, useState } from "react";
import { useActionData, useLoaderData, useSubmit } from "react-router";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  Select,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Fetch locations from shopify & saved settings from DB
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Fetch all locations from shopify
  const response = await admin.graphql(
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
  const data = await response.json();
  const shopifyLocations = data.data.locations.nodes;

  // Fetch saved setting from database
  const config = await prisma.configuration.findUnique({
    where: { shop: session.shop },
  });

  // Return plain object (no need for json() wrapper in v7)
  return {
    locations: shopifyLocations,
    savedLocationId: config?.locationId || "",
  };
};

// Save the user's choice to the DB
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const selectedLocationId = formData.get("locationId");

  await prisma.configuration.upsert({
    where: { shop: session.shop },
    update: { locationId: selectedLocationId },
    create: {
      shop: session.shop,
      locationId: selectedLocationId,
    },
  });

  return { status: "success" };
};

// UI components
export default function Index() {
  const { locations, savedLocationId } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();

  const [selected, setSelected] = useState(savedLocationId);

  // Update state if loader data changes
  useEffect(() => {
    setSelected(savedLocationId);
  }, [savedLocationId]);

  // Handle save button
  const handleSave = () => {
    submit({ locationId: selected }, { method: "POST" });
  };

  // Create options for the dropdown
  const options = [
    { label: "Select a location...", value: "" },
    ...locations.map((loc) => ({
      label: loc.name,
      value: loc.id,
    })),
  ];

  return (
    <Page title="Chrono Split Settings">
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="500">
                <Text as="h2" variant="headingMd">
                  Configuration
                </Text>

                {actionData?.status === "success" && (
                  <Banner tone="success">Settings saved successfully!</Banner>
                )}

                <Text as="p">
                  Select which warehouse contains your <b>Pre-Sale</b> inventory.
                  Orders from this location will be automatically held and tagged.
                </Text>

                <Select
                  label="Pre-Sale Location"
                  options={options}
                  onChange={setSelected}
                  value={selected}
                />

                <Button variant="primary" onClick={handleSave}>
                  Save Settings
                </Button>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
