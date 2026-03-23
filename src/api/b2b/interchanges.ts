import { logInfo } from "../../serverUtils";
import { getOAuthToken } from "../api_destination";

const getAuthHeader = async (): Promise<string> => {
	if (process.env.API_OAUTH_TOKEN_URL) {
		const token = await getOAuthToken();
		return token.http_header.value;
	}
	if (process.env.API_USER && process.env.API_PASS) {
		const encoded = Buffer.from(`${process.env.API_USER}:${process.env.API_PASS}`).toString("base64");
		return `Basic ${encoded}`;
	}
	throw new Error("No authentication method available for B2B API");
};

const getB2BBaseUrl = (): string => {
	// B2B Monitor uses the same /api/v1 base as CPI monitoring (NOT /odata/api/v1)
	// API_BASE_URL already includes /api/v1 — use it directly
	const base = process.env.API_BASE_URL
		|| (process.env.CPI_BASE_URL ? `${process.env.CPI_BASE_URL}/api/v1` : "");
	if (!base) throw new Error("API_BASE_URL or CPI_BASE_URL must be set");
	return base.replace(/\/$/, "");
};

const b2bFetch = async (path: string): Promise<unknown> => {
	const baseUrl = getB2BBaseUrl();
	const authHeader = await getAuthHeader();
	const url = `${baseUrl}${path}`;
	logInfo(`B2B API: GET ${url}`);
	const response = await fetch(url, {
		headers: {
			Authorization: authHeader,
			Accept: "application/json",
		},
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`B2B API error ${response.status}: ${text}`);
	}
	return response.json();
};

const b2bFetchRaw = async (path: string): Promise<string> => {
	const baseUrl = getB2BBaseUrl();
	const authHeader = await getAuthHeader();
	const url = `${baseUrl}${path}`;
	logInfo(`B2B API (raw): GET ${url}`);
	const response = await fetch(url, {
		headers: { Authorization: authHeader },
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`B2B API error ${response.status}: ${text}`);
	}
	return response.text();
};

export interface InterchangeFilter {
	leftBoundDate: string;       // ISO 8601, e.g. "2026-03-13T00:00:00.000Z"
	rightBoundDate?: string;
	overallStatuses?: string[];  // e.g. ["COMPLETED", "FAILED"]
	processingStatuses?: string[];
	senderIdentifier?: string;
	receiverIdentifier?: string;
	senderDocumentStandard?: string;
	senderMessageType?: string;
	receiverDocumentStandard?: string;
	receiverMessageType?: string;
	senderAdapterType?: string;
}

/**
 * Build OData v2 $filter string matching the mcp-is-tpm logic
 */
const buildFilter = (f: InterchangeFilter): string => {
	const fmtDate = (iso: string) => {
		// OData v2 datetime literal: datetime'YYYY-MM-DDTHH:mm:ss'
		const d = new Date(iso);
		const pad = (n: number) => String(n).padStart(2, "0");
		return `datetime'${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}'`;
	};

	const parts: string[] = [`StartedAt ge ${fmtDate(f.leftBoundDate)}`];

	if (f.rightBoundDate) {
		parts.push(`StartedAt le ${fmtDate(f.rightBoundDate)}`);
	}
	if (f.overallStatuses?.length) {
		parts.push(`(${f.overallStatuses.map(s => `OverallStatus eq '${s}'`).join(" or ")})`);
	}
	if (f.processingStatuses?.length) {
		parts.push(`(${f.processingStatuses.map(s => `ProcessingStatus eq '${s}'`).join(" or ")})`);
	}
	if (f.senderIdentifier) {
		parts.push(`AgreedSenderIdentiferAtSenderSide eq '${f.senderIdentifier}'`);
	}
	if (f.receiverIdentifier) {
		parts.push(`AgreedReceiverIdentiferAtSenderSide eq '${f.receiverIdentifier}'`);
	}
	if (f.senderAdapterType) {
		parts.push(`SenderAdapterType eq '${f.senderAdapterType}'`);
	}
	if (f.senderDocumentStandard) {
		parts.push(`SenderDocumentStandard eq '${f.senderDocumentStandard}'`);
	}
	if (f.senderMessageType) {
		parts.push(`SenderMessageType eq '${f.senderMessageType}'`);
	}
	if (f.receiverDocumentStandard) {
		parts.push(`ReceiverDocumentStandard eq '${f.receiverDocumentStandard}'`);
	}
	if (f.receiverMessageType) {
		parts.push(`ReceiverMessageType eq '${f.receiverMessageType}'`);
	}

	return parts.join(" and ");
};

export const searchInterchanges = async (filter: InterchangeFilter): Promise<unknown> => {
	const rawFilter = buildFilter(filter);
	const encodedFilter = encodeURIComponent(rawFilter);
	const path = `/BusinessDocuments?$orderby=StartedAt desc&$filter=${encodedFilter}&$format=json`;
	return b2bFetch(path);
};

export const getInterchangePayloads = async (interchangeId: string): Promise<unknown> => {
	const path = `/BusinessDocuments('${encodeURIComponent(interchangeId)}')/BusinessDocumentPayloads?$expand=BusinessDocumentProcessingEvent&$format=json`;
	return b2bFetch(path);
};

export const getInterchangeLastError = async (interchangeId: string): Promise<unknown> => {
	const path = `/BusinessDocuments('${encodeURIComponent(interchangeId)}')/LastErrorDetails?$format=json`;
	return b2bFetch(path);
};

export const downloadInterchangePayload = async (payloadId: string): Promise<string> => {
	const path = `/BusinessDocumentPayloads('${encodeURIComponent(payloadId)}')/$value`;
	return b2bFetchRaw(path);
};
