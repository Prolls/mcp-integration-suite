import { logInfo } from "../../serverUtils";

let tokenCache: { accessToken: string; expiresAt: number } | null = null;

const getApimToken = async (): Promise<string> => {
	const now = Date.now();
	if (tokenCache && tokenCache.expiresAt > now + 5 * 60 * 1000) return tokenCache.accessToken;

	const tokenUrl = process.env.APIM_TOKEN_URL;
	const clientId = process.env.APIM_CLIENT_ID;
	const clientSecret = process.env.APIM_CLIENT_SECRET;
	if (!tokenUrl || !clientId || !clientSecret)
		throw new Error("APIM_TOKEN_URL, APIM_CLIENT_ID and APIM_CLIENT_SECRET must be set");

	const params = new URLSearchParams();
	params.append("grant_type", "client_credentials");
	params.append("client_id", clientId);
	params.append("client_secret", clientSecret);

	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params,
	});
	if (!response.ok) throw new Error(`APIM token error ${response.status}: ${await response.text()}`);

	const data = await response.json() as { access_token: string; expires_in: number };
	tokenCache = { accessToken: data.access_token, expiresAt: now + data.expires_in * 1000 };
	return data.access_token;
};

const apimBase = () => (process.env.APIM_BASE_URL || "").replace(/\/$/, "");

const apimFetch = async (path: string): Promise<unknown> => {
	const token = await getApimToken();
	const url = `${apimBase()}${path}`;
	logInfo(`APIM: GET ${url}`);
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
	});
	if (!response.ok) throw new Error(`APIM error ${response.status}: ${await response.text()}`);
	return response.json();
};

const apimPost = async (path: string, body: unknown): Promise<unknown> => {
	const token = await getApimToken();
	const url = `${apimBase()}${path}`;
	logInfo(`APIM: POST ${url}`);
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`APIM POST error ${response.status}: ${await response.text()}`);
	const text = await response.text();
	return text ? JSON.parse(text) : null;
};

const apimPatch = async (path: string, body: unknown): Promise<void> => {
	const token = await getApimToken();
	const url = `${apimBase()}${path}`;
	logInfo(`APIM: PATCH ${url}`);
	const response = await fetch(url, {
		method: "PATCH",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`APIM PATCH error ${response.status}: ${await response.text()}`);
};

export interface ApiProxy {
	name: string;
	state: string;
	status_code: string;
	provider_name: string;
	version: string;
	description: string;
	basepathprefix: string;
	isPublished: boolean;
	releaseStatus: string;
	service_code: string;
	life_cycle: { changed_at: string; changed_by: string; created_at: string; created_by: string };
}

const parseDateValue = (val: string | undefined): string => {
	if (!val) return "";
	const match = val.match(/\/Date\((\d+)\)\//);
	if (!match) return val;
	return new Date(parseInt(match[1])).toISOString();
};

const mapProxy = (r: Record<string, unknown>): ApiProxy => ({
	name: r.name as string,
	state: r.state as string,
	status_code: r.status_code as string,
	provider_name: r.provider_name as string,
	version: r.version as string,
	description: (r.description as string) || "",
	basepathprefix: (r.basepathprefix as string) || "",
	isPublished: r.isPublished as boolean,
	releaseStatus: r.releaseStatus as string,
	service_code: r.service_code as string,
	life_cycle: {
		changed_at: parseDateValue((r.life_cycle as Record<string, string>)?.changed_at),
		changed_by: (r.life_cycle as Record<string, string>)?.changed_by || "",
		created_at: parseDateValue((r.life_cycle as Record<string, string>)?.created_at),
		created_by: (r.life_cycle as Record<string, string>)?.created_by || "",
	},
});

export const listProxies = async (filter?: string): Promise<ApiProxy[]> => {
	let path = "/apiportal/api/1.0/Management.svc/APIProxies?$orderby=name";
	if (filter) path += `&$filter=${encodeURIComponent(filter)}`;
	const data = await apimFetch(path) as { d: { results: Record<string, unknown>[] } };
	return data.d.results.map(mapProxy);
};

export const getProxy = async (name: string): Promise<unknown> => {
	const path = `/apiportal/api/1.0/Management.svc/APIProxies('${encodeURIComponent(name)}')`;
	const data = await apimFetch(path) as { d: Record<string, unknown> };
	return mapProxy(data.d);
};

export const getProxyPolicies = async (name: string): Promise<unknown> => {
	const path = `/apiportal/api/1.0/Management.svc/APIProxies('${encodeURIComponent(name)}')/proxyEndPoints?$expand=APIResources,proxyEndPointPolicies,targetEndPoints`;
	return apimFetch(path);
};

export const listApplications = async (): Promise<unknown> => {
	const path = "/apiportal/api/1.0/Management.svc/Applications?$expand=AppCredentials";
	return apimFetch(path);
};

export const listProducts = async (): Promise<unknown> => {
	const path = "/apiportal/api/1.0/Management.svc/APIProducts?$orderby=name";
	return apimFetch(path);
};

// ─── Policy operations ─────────────────────────────────────────────────────

interface ProxyEndpointInfo {
	endpointId: string;
	preFlowRequestStreamId: string | null;
	preFlowResponseStreamId: string | null;
	postFlowRequestStreamId: string | null;
	postFlowResponseStreamId: string | null;
}

export const getProxyEndpointInfo = async (proxyName: string): Promise<ProxyEndpointInfo> => {
	// 1. Get the proxy endpoint
	const epData = await apimFetch(
		`/apiportal/api/1.0/Management.svc/APIProxies('${encodeURIComponent(proxyName)}')/proxyEndPoints?$expand=preFlow,postFlow`
	) as { d: { results: Record<string, unknown>[] } };

	const ep = epData.d.results[0];
	if (!ep) throw new Error(`No proxy endpoint found for proxy '${proxyName}'`);
	const endpointId = ep.id as string;

	const preFlow = ep.preFlow as Record<string, unknown> | undefined;
	const postFlow = ep.postFlow as Record<string, unknown> | undefined;

	return {
		endpointId,
		preFlowRequestStreamId: (preFlow?.FK_REQUEST_ID as string) || null,
		preFlowResponseStreamId: (preFlow?.FK_RESPONSE_ID as string) || null,
		postFlowRequestStreamId: (postFlow?.FK_REQUEST_ID as string) || null,
		postFlowResponseStreamId: (postFlow?.FK_RESPONSE_ID as string) || null,
	};
};

export const getProxyPoliciesList = async (proxyName: string): Promise<unknown[]> => {
	const data = await apimFetch(
		`/apiportal/api/1.0/Management.svc/Policies?$filter=FK_API_NAME eq '${encodeURIComponent(proxyName)}'`
	) as { d: { results: Record<string, unknown>[] } };
	return data.d.results.map(p => ({
		id: p.id,
		name: p.name,
		type: p.type,
		policy_content: p.policy_content,
	}));
};

export const getStreamSteps = async (streamId: string): Promise<{ maxSequence: number; policyNames: string[] }> => {
	const data = await apimFetch(
		`/apiportal/api/1.0/Management.svc/Streams('${streamId}')/steps`
	) as { d: { results: Record<string, unknown>[] } };
	const steps = data.d.results;
	return {
		maxSequence: steps.reduce((max, s) => Math.max(max, (s.sequence as number) || 0), 0),
		policyNames: steps.map(s => s.policy_name as string),
	};
};

export interface ApplyPolicyResult {
	proxyName: string;
	status: "applied" | "already_exists" | "error";
	detail?: string;
}

/**
 * Apply a policy to a single proxy's specified flow/side.
 * flow: "preFlow" | "postFlow"
 * side: "request" | "response"
 */
export const applyPolicyToProxy = async (
	proxyName: string,
	policyName: string,
	policyType: string,
	policyXml: string,
	flow: "preFlow" | "postFlow",
	side: "request" | "response"
): Promise<ApplyPolicyResult> => {
	try {
		// 1. Get endpoint info
		const epInfo = await getProxyEndpointInfo(proxyName);
		const streamId = flow === "preFlow"
			? (side === "request" ? epInfo.preFlowRequestStreamId : epInfo.preFlowResponseStreamId)
			: (side === "request" ? epInfo.postFlowRequestStreamId : epInfo.postFlowResponseStreamId);

		if (!streamId) {
			return { proxyName, status: "error", detail: `No ${flow} ${side} stream found` };
		}

		// 2. Check if policy already exists
		const existingPolicies = await getProxyPoliciesList(proxyName);
		const existing = existingPolicies.find((p: unknown) => (p as Record<string, string>).name === policyName);

		if (!existing) {
			// Create the policy
			await apimPost("/apiportal/api/1.0/Management.svc/Policies", {
				FK_API_NAME: proxyName,
				name: policyName,
				type: policyType,
				policy_content: policyXml,
			});
		} else {
			// Update existing policy content
			const policyId = (existing as Record<string, string>).id;
			await apimPatch(`/apiportal/api/1.0/Management.svc/Policies('${policyId}')`, {
				policy_content: policyXml,
			});
		}

		// 3. Check if step already exists in this stream for this policy
		const streamInfo = await getStreamSteps(streamId);
		if (streamInfo.policyNames.includes(policyName)) {
			return { proxyName, status: "already_exists", detail: "Policy already attached to this flow" };
		}

		// 4. Create the step
		await apimPost("/apiportal/api/1.0/Management.svc/Steps", {
			FK_STREAM_ID: streamId,
			policy_name: policyName,
			sequence: streamInfo.maxSequence + 1,
			condition: "",
		});

		return { proxyName, status: "applied" };
	} catch (err) {
		return { proxyName, status: "error", detail: String(err) };
	}
};

export const deployProxy = async (proxyName: string): Promise<void> => {
	await apimPost(
		`/apiportal/api/1.0/Management.svc/APIProxies('${encodeURIComponent(proxyName)}')/APIProxyDeployments`,
		{}
	);
};

// ─── Proxy creation ─────────────────────────────────────────────────────────

export interface CreateProxyInput {
	name: string;
	title: string;
	description: string;
	version: string;
	providerName: string;
	basePath: string;
	targetUrl: string;
	serviceCode?: string;
}

export const createProxy = async (input: CreateProxyInput): Promise<string> => {
	// 1. Create the proxy
	const proxyResult = await apimPost("/apiportal/api/1.0/Management.svc/APIProxies", {
		name: input.name,
		title: input.title,
		description: input.description,
		version: input.version,
		provider_name: input.providerName,
		FK_PROVIDERNAME: input.providerName,
		service_code: input.serviceCode || "ODATA",
		isPublished: false,
		isVersioned: true,
		releaseStatus: "Active",
	}) as { d: Record<string, unknown> };

	const proxyName = proxyResult.d.name as string;

	// 2. Create proxy endpoint
	const epResult = await apimPost("/apiportal/api/1.0/Management.svc/APIProxyEndPoints", {
		FK_API_NAME: proxyName,
		base_path: input.basePath,
		name: "default",
		isDefault: true,
	}) as { d: Record<string, unknown> };

	const endpointId = epResult.d.id as string;

	// 3. Create target endpoint
	await apimPost("/apiportal/api/1.0/Management.svc/APITargetEndPoints", {
		FK_API_NAME: proxyName,
		FK_PROXYENDPOINT_NAME: endpointId,
		name: "default",
		url: input.targetUrl,
		isDefault: true,
	});

	return proxyName;
};

export const getAnalyticsReport = async (
	fromDate: string,
	toDate: string,
	metric: string,
	proxyName?: string
): Promise<unknown> => {
	// SAP APIM analytics via the report execution endpoint
	let filter = `(date ge datetime'${fromDate}' and date le datetime'${toDate}')`;
	if (proxyName) filter += ` and (apiProxyName eq '${proxyName}')`;
	const path = `/apiportal/api/1.0/Analytics.svc/${metric}?$filter=${encodeURIComponent(filter)}`;
	return apimFetch(path);
};
