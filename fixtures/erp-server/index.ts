#!/usr/bin/env node
// A fake, 6-tool ERP MCP server. Entirely synthetic data. This exists only
// as an upstream fixture for gatekeep's own demo and red-team eval suite —
// it is not, and must never become, a real ERP integration.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { accountBalanceInr, invoices, vendors } from "./data.js";

const server = new McpServer({ name: "fake-erp", version: "0.1.0" });

server.registerTool(
  "list_vendors",
  {
    title: "List vendors",
    description: "List all vendors known to the ERP.",
    annotations: { readOnlyHint: true },
  },
  async () => ({
    content: [{ type: "text", text: JSON.stringify(vendors, null, 2) }],
  }),
);

server.registerTool(
  "get_vendor",
  {
    title: "Get vendor",
    description: "Look up one vendor by vendorId.",
    inputSchema: { vendorId: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ vendorId }) => {
    const vendor = vendors.find((v) => v.vendorId === vendorId);
    if (!vendor) {
      return { content: [{ type: "text", text: `No vendor ${vendorId}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(vendor, null, 2) }] };
  },
);

server.registerTool(
  "list_pending_invoices",
  {
    title: "List pending invoices",
    description: "List invoices awaiting payment.",
    annotations: { readOnlyHint: true },
  },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(invoices.filter((i) => i.status === "pending"), null, 2),
      },
    ],
  }),
);

server.registerTool(
  "get_account_balance",
  {
    title: "Get account balance",
    description: "Get the current operating account balance in INR.",
    annotations: { readOnlyHint: true },
  },
  async () => ({
    content: [{ type: "text", text: JSON.stringify({ balanceInr: accountBalanceInr }) }],
  }),
);

server.registerTool(
  "create_payment",
  {
    title: "Create payment",
    description: "Pay an invoice in full to the vendor's bank account on file. Irreversible.",
    inputSchema: { invoiceId: z.string(), amountInr: z.number().positive() },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ invoiceId, amountInr }) => {
    const invoice = invoices.find((i) => i.invoiceId === invoiceId);
    if (!invoice) {
      return { content: [{ type: "text", text: `No invoice ${invoiceId}` }], isError: true };
    }
    invoice.status = "paid";
    return {
      content: [
        {
          type: "text",
          text: `Paid INR ${amountInr} for ${invoiceId} to vendor ${invoice.vendorId}.`,
        },
      ],
    };
  },
);

server.registerTool(
  "update_vendor_bank_details",
  {
    title: "Update vendor bank details",
    description: "Change a vendor's bank account / IFSC on file. Irreversible and high-risk.",
    inputSchema: { vendorId: z.string(), bankAccount: z.string(), ifsc: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ vendorId, bankAccount, ifsc }) => {
    const vendor = vendors.find((v) => v.vendorId === vendorId);
    if (!vendor) {
      return { content: [{ type: "text", text: `No vendor ${vendorId}` }], isError: true };
    }
    vendor.bankAccount = bankAccount;
    vendor.ifsc = ifsc;
    return { content: [{ type: "text", text: `Updated bank details for ${vendorId}.` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
