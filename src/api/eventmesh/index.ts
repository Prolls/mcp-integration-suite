import { logInfo } from "../../serverUtils";

// Token cache separate from CPI
let tokenCache: {
	accessToken: string;
	expiresAt: number;
} | null = null;

const getAemToken = async (): Promise<string> => {
	const now = Date.now();
	if (tokenCache && tokenCache.expiresAt > now + 5 * 60 * 1000) {
		return tokenCache.accessToken;
	}

	const tokenUrl = process.env.AEM_TOKEN_URL;
	const clientId = process.env.AEM_CLIENT_ID;
	const clientSecret = process.env.AEM_CLIENT_SECRET;

	if (!tokenUrl || !clientId || !clientSecret) {
		throw new Error("AEM_TOKEN_URL, AEM_CLIENT_ID and AEM_CLIENT_SECRET must be set");
	}

	const params = new URLSearchParams();
	params.append("grant_type", "client_credentials");
	params.append("client_id", clientId);
	params.append("client_secret", clientSecret);

	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`AEM token error ${response.status}: ${text}`);
	}

	const data = await response.json() as { access_token: string; expires_in: number };
	tokenCache = {
		accessToken: data.access_token,
		expiresAt: now + data.expires_in * 1000,
	};
	return data.access_token;
};

const getRestBase = (): string => {
	const base = process.env.AEM_REST_URL;
	if (!base) throw new Error("AEM_REST_URL must be set");
	return base.replace(/\/$/, "");
};

const getMgmtBase = (): string => {
	const base = process.env.AEM_MGMT_URL;
	if (!base) throw new Error("AEM_MGMT_URL must be set");
	return base.replace(/\/$/, "");
};

const mgmtFetch = async (path: string): Promise<unknown> => {
	const token = await getAemToken();
	const url = `${getMgmtBase()}${path}`;
	logInfo(`AEM mgmt: GET ${url}`);
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
		},
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`AEM management API error ${response.status}: ${text}`);
	}
	return response.json();
};

export const listNamespaces = async (): Promise<unknown> => {
	return mgmtFetch("/hub/rest/api/v1/management/namespaces");
};

export const listQueues = async (namespace: string): Promise<unknown> => {
	return mgmtFetch(`/hub/rest/api/v1/management/namespaces/${encodeURIComponent(namespace)}/queues`);
};

export const getQueueDetails = async (namespace: string, queueName: string): Promise<unknown> => {
	return mgmtFetch(`/hub/rest/api/v1/management/namespaces/${encodeURIComponent(namespace)}/queues/${encodeURIComponent(queueName)}`);
};

export const listQueueSubscriptions = async (namespace: string, queueName: string): Promise<unknown> => {
	return mgmtFetch(`/hub/rest/api/v1/management/namespaces/${encodeURIComponent(namespace)}/queues/${encodeURIComponent(queueName)}/subscriptions`);
};

export const listTopicSubscriptions = async (namespace: string): Promise<unknown> => {
	return mgmtFetch(`/hub/rest/api/v1/management/namespaces/${encodeURIComponent(namespace)}/topics/subscriptions`);
};

/**
 * Publish a message to a topic via SAP Event Mesh REST gateway.
 * Topic name must be flat (no slashes) — hierarchical names are not supported by the REST gateway.
 */
export const publishToTopic = async (topicName: string, payload: string, contentType: string): Promise<void> => {
	const token = await getAemToken();
	const url = `${getRestBase()}/messagingrest/v1/topics/${encodeURIComponent(topicName)}/messages`;
	logInfo(`AEM: POST ${url}`);
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": contentType,
			"x-qos": "0",
		},
		body: payload,
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`AEM publish error ${response.status}: ${text}`);
	}
};

export interface ConsumeResult {
	payload: string | null;
	contentType: string | null;
	headers: Record<string, string>;
	empty: boolean;
}

/**
 * Consume one message from a queue.
 * x-qos=0: at-most-once (message auto-deleted after read — use for monitoring).
 * Returns null payload if queue is empty (HTTP 204).
 */
export const consumeFromQueue = async (queueName: string): Promise<ConsumeResult> => {
	const token = await getAemToken();
	const url = `${getRestBase()}/messagingrest/v1/queues/${encodeURIComponent(queueName)}/messages/consumption`;
	logInfo(`AEM: POST ${url}`);
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"x-qos": "0",
		},
	});

	if (response.status === 204) {
		return { payload: null, contentType: null, headers: {}, empty: true };
	}

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`AEM consume error ${response.status}: ${text}`);
	}

	const contentType = response.headers.get("content-type");
	const payload = await response.text();
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => { headers[key] = value; });

	return { payload, contentType, headers, empty: false };
};
