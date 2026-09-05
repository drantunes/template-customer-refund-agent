import { expect, test } from "@playwright/test";

test("renders the local deterministic demo and reaches the portal", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Welcome to the demo")).toBeVisible();
  await page.getByRole("link", { name: "Let's go" }).click();
  await expect(page).toHaveURL(/\/portal$/);
  await expect(
    page.getByRole("heading", { name: "Customer portal" }),
  ).toBeVisible();
});
