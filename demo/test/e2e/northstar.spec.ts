import { expect, test } from "@playwright/test";

test("public support launcher requires login and then shows the customer account", async ({
  page,
}) => {
  await page.goto("/atendimento");
  await expect(
    page.getByRole("heading", { name: "Entre para acompanhar seu suporte." }),
  ).toBeVisible();
  await page.getByLabel("E-mail").fill("customer@example.test");
  await page.getByLabel("Senha").fill("test-password");
  await page.getByRole("button", { name: "Entrar na conta" }).click();
  await expect(
    page.getByRole("heading", { name: "Olá, Cliente E2E." }),
  ).toBeVisible();
  await expect(page.getByText("Starter Toolkit")).toBeVisible();
  await expect(
    page.getByText(
      "Não foi possível consultar as solicitações agora. Tente novamente em instantes.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sair" }).click();
  await expect(
    page.getByRole("heading", { name: "Entre para acompanhar seu suporte." }),
  ).toBeVisible();
});
