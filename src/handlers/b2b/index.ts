import { z } from "zod";
import { McpServerWithMiddleware } from "../../utils/middleware";
import { formatError } from "../../utils/customErrHandler";
import {
	searchInterchanges,
	getInterchangePayloads,
	getInterchangeLastError,
	downloadInterchangePayload,
} from "../../api/b2b/interchanges";

const interchangeFilterSchema = z.object({
	leftBoundDate: z.string().describe(
		"Start date (ISO 8601, e.g. 2026-03-13T00:00:00.000Z). Required."
	),
	rightBoundDate: z.string().optional().describe(
		"End date (ISO 8601). Defaults to now if not provided."
	),
	overallStatuses: z.array(z.string()).optional().describe(
		"Filter by overall status, e.g. ['COMPLETED', 'FAILED']"
	),
	processingStatuses: z.array(z.string()).optional().describe(
		"Filter by processing status, e.g. ['PROCESSED', 'AWAITING_PROCESSING']"
	),
	senderIdentifier: z.string().optional().describe(
		"Sender identifier (AgreedSenderIdentiferAtSenderSide)"
	),
	receiverIdentifier: z.string().optional().describe(
		"Receiver identifier (AgreedReceiverIdentiferAtSenderSide)"
	),
	senderDocumentStandard: z.string().optional().describe(
		"Sender document standard, e.g. 'EDIFACT', 'ANSI_X12'"
	),
	senderMessageType: z.string().optional().describe(
		"Sender message type, e.g. 'DESADV', 'ORDERS'"
	),
	receiverDocumentStandard: z.string().optional().describe(
		"Receiver document standard"
	),
	receiverMessageType: z.string().optional().describe(
		"Receiver message type"
	),
	senderAdapterType: z.string().optional().describe(
		"Sender adapter type, e.g. 'AS2', 'SFTP'"
	),
});

export const registerB2BHandlers = (server: McpServerWithMiddleware) => {
	server.registerToolIntegrationSuite(
		"search-interchanges",
		`Search B2B interchanges in the SAP Integration Suite B2B Monitor (Trading Partner Management).
Use this tool to find EDI messages (DESADV, ORDERS, INVOIC, etc.) exchanged with trading partners.
This is separate from the standard message monitoring — it covers the B2B/TPM flow engine.
Results include interchange ID, overall status, processing status, sender/receiver identifiers, message type, and timestamps.`,
		interchangeFilterSchema.shape,
		async (params) => {
			try {
				const result = await searchInterchanges(params as z.infer<typeof interchangeFilterSchema>);
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
				};
			} catch (error) {
				return { isError: true, content: [formatError(error)] };
			}
		}
	);

	server.registerToolIntegrationSuite(
		"get-interchange-payloads",
		`Get all payload data (with processing events) for a specific B2B interchange.
Returns the list of payloads (raw EDI/XML) and their processing history.
Use the interchange ID returned by search-interchanges.`,
		{
			interchangeId: z.string().describe("ID of the interchange (from search-interchanges)"),
		},
		async ({ interchangeId }) => {
			try {
				const result = await getInterchangePayloads(interchangeId);
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
				};
			} catch (error) {
				return { isError: true, content: [formatError(error)] };
			}
		}
	);

	server.registerToolIntegrationSuite(
		"get-interchange-last-error",
		`Get the last error details for a failed B2B interchange.
Use this when search-interchanges returns an interchange with OverallStatus FAILED.`,
		{
			interchangeId: z.string().describe("ID of the interchange (from search-interchanges)"),
		},
		async ({ interchangeId }) => {
			try {
				const result = await getInterchangeLastError(interchangeId);
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
				};
			} catch (error) {
				return { isError: true, content: [formatError(error)] };
			}
		}
	);

	server.registerToolIntegrationSuite(
		"download-interchange-payload",
		`Download the raw content (EDI/XML) of a specific B2B payload by its ID.
Use the payload ID from get-interchange-payloads.
Returns the raw message content as text.`,
		{
			payloadId: z.string().describe("ID of the payload (from get-interchange-payloads)"),
		},
		async ({ payloadId }) => {
			try {
				const result = await downloadInterchangePayload(payloadId);
				return {
					content: [{ type: "text", text: result }],
				};
			} catch (error) {
				return { isError: true, content: [formatError(error)] };
			}
		}
	);
};
