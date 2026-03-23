import { z } from "zod";
import { McpServerWithMiddleware } from "../../utils/middleware";
import { formatError } from "../../utils/customErrHandler";
import {
	listProxies, getProxy, getProxyPolicies, listApplications, listProducts,
	getProxyPoliciesList, applyPolicyToProxy, deployProxy, createProxy,
} from "../../api/apim";

export const registerApimHandlers = (server: McpServerWithMiddleware) => {
	server.registerToolIntegrationSuite(
		"apim-list-proxies",
		`List all SAP API Management proxies with their deployment state and status.
Providers indicate the backend SAP system (VS7=VS7 prod, DS7=dev, QS7=QA, PS7/PS8=pre-prod, VS8=VS8 prod).
States: DEPLOYED (active), UNDEPLOYED (inactive).
Status: PUBLISHED (visible in developer portal), REGISTERED (internal only).
Use this to get an overview of all exposed APIs or search for a specific proxy.`,
		{
			providerFilter: z.string().optional().describe(
				"Filter by provider/system name, e.g. 'VS7', 'DS7'. Leave empty for all."
			),
			nameSearch: z.string().optional().describe(
				"Search by proxy name (case-insensitive substring). Leave empty for all."
			),
		},
		async ({ providerFilter, nameSearch }) => {
			try {
				let filter: string | undefined;
				if (providerFilter) filter = `provider_name eq '${providerFilter}'`;
				const proxies = await listProxies(filter);
				const filtered = nameSearch
					? proxies.filter(p => p.name.toLowerCase().includes(nameSearch.toLowerCase()))
					: proxies;
				const summary = filtered.map(p => ({
					name: p.name,
					provider: p.provider_name,
					state: p.state,
					status: p.status_code,
					version: p.version,
					lastChanged: p.life_cycle.changed_at,
					changedBy: p.life_cycle.changed_by,
				}));
				return {
					content: [{
						type: "text",
						text: `${filtered.length} proxies found.\n\n${JSON.stringify(summary, null, 2)}`,
					}],
				};
			} catch (error) {
				return { isError: true, content: [formatError(error)] };
			}
		}
	);

	server.registerToolIntegrationSuite(
		"apim-get-proxy",
		`Get details of a specific SAP API Management proxy.
Returns deployment state, base path, provider system, release status, and policy configuration.`,
		{
			proxyName: z.string().describe("Exact proxy name (from apim-list-proxies)"),
			includePolicies: z.boolean().optional().default(false).describe(
				"Include proxy endpoint policies and resources (default: false)"
			),
		},
		async ({ proxyName, includePolicies }) => {
			try {
				const proxy = await getProxy(proxyName);
				let result: unknown = proxy;
				if (includePolicies) {
					const policies = await getProxyPolicies(proxyName);
					result = { proxy, policies };
				}
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return { isError: true, content: [formatError(error)] };
			}
		}
	);

	server.registerToolIntegrationSuite(
		"apim-list-products",
		`List all API products in SAP API Management.
API products bundle one or more API proxies and define rate limits and access scope for consumers.`,
		{},
		async () => {
			try {
				const result = await listProducts();
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return { isError: true, content: [formatError(error)] };
			}
		}
	);

	server.registerToolIntegrationSuite(
		"apim-list-applications",
		`List all registered applications in SAP API Management.
Applications represent API consumers with their credentials (API keys).
Returns app name, status, and associated credentials.`,
		{},
		async () => {
			try {
				const result = await listApplications();
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return { isError: true, content: [formatError(error)] };
			}
		}
	);

	server.registerToolIntegrationSuite(
		"apim-get-proxy-policies",
		`List all policies attached to a specific SAP API Management proxy.
Returns policy name, type, and XML content for each policy.`,
		{
			proxyName: z.string().describe("Exact proxy name"),
		},
		async ({ proxyName }) => {
			try {
				const policies = await getProxyPoliciesList(proxyName);
				return { content: [{ type: "text", text: JSON.stringify(policies, null, 2) }] };
			} catch (error) {
				return { isError: true, content: [formatError(error)] };
			}
		}
	);

	server.registerToolIntegrationSuite(
		"apim-apply-policy",
		`Apply a policy to a single SAP API Management proxy.
Creates the policy if it doesn't exist, or updates it if it does.
Then attaches the policy to the specified flow and side (request/response).
Use apim-deploy-proxy after applying policies to make changes effective.`,
		{
			proxyName: z.string().describe("Exact proxy name"),
			policyName: z.string().describe("Policy name (unique per proxy, e.g. 'SetHeaderPolicy')"),
			policyType: z.string().describe("Policy type as known by APIM, e.g. 'AssignMessage', 'SpikeArrest', 'VerifyAPIKey'"),
			policyXml: z.string().describe("Policy XML content"),
			flow: z.enum(["preFlow", "postFlow"]).describe("Which flow to attach to"),
			side: z.enum(["request", "response"]).describe("Request or response side"),
		},
		async ({ proxyName, policyName, policyType, policyXml, flow, side }) => {
			try {
				const result = await applyPolicyToProxy(proxyName, policyName, policyType, policyXml, flow, side);
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return { isError: true, content: [formatError(error)] };
			}
		}
	);

	server.registerToolIntegrationSuite(
		"apim-bulk-apply-policy",
		`Apply the same policy to multiple SAP API Management proxies at once.
Filters proxies by provider name and/or name substring, then applies the policy to each.
Returns a result per proxy indicating: applied, already_exists, or error.
Use apim-deploy-proxy on each proxy after applying policies.`,
		{
			policyName: z.string().describe("Policy name to apply"),
			policyType: z.string().describe("Policy type, e.g. 'AssignMessage', 'SpikeArrest'"),
			policyXml: z.string().describe("Policy XML content"),
			flow: z.enum(["preFlow", "postFlow"]).describe("Which flow to attach to"),
			side: z.enum(["request", "response"]).describe("Request or response side"),
			providerFilter: z.string().optional().describe("Filter proxies by provider_name (e.g. 'VS7')"),
			nameSearch: z.string().optional().describe("Filter proxies by name substring"),
			dryRun: z.boolean().optional().default(false).describe("If true, only list matching proxies without applying"),
		},
		async ({ policyName, policyType, policyXml, flow, side, providerFilter, nameSearch, dryRun }) => {
			try {
				let filter: string | undefined;
				if (providerFilter) filter = `provider_name eq '${providerFilter}'`;
				const proxies = await listProxies(filter);
				const targeted = nameSearch
					? proxies.filter(p => p.name.toLowerCase().includes(nameSearch.toLowerCase()))
					: proxies;

				if (dryRun) {
					return {
						content: [{
							type: "text",
							text: `Dry run: ${targeted.length} proxies would be targeted.\n\n${JSON.stringify(targeted.map(p => p.name), null, 2)}`,
						}],
					};
				}

				const results = await Promise.all(
					targeted.map(p => applyPolicyToProxy(p.name, policyName, policyType, policyXml, flow, side))
				);

				const summary = {
					total: results.length,
					applied: results.filter(r => r.status === "applied").length,
					already_exists: results.filter(r => r.status === "already_exists").length,
					errors: results.filter(r => r.status === "error").length,
				};

				return {
					content: [{
						type: "text",
						text: `Bulk policy apply complete.\n\n${JSON.stringify(summary, null, 2)}\n\nDetails:\n${JSON.stringify(results, null, 2)}`,
					}],
				};
			} catch (error) {
				return { isError: true, content: [formatError(error)] };
			}
		}
	);

	server.registerToolIntegrationSuite(
		"apim-create-proxy",
		`Create a new API proxy in SAP API Management.
Creates the proxy, a default proxy endpoint with the given base path, and a default target endpoint pointing to the backend URL.
Returns the created proxy name.`,
		{
			name: z.string().describe("Proxy name (unique identifier)"),
			title: z.string().describe("Display title"),
			description: z.string().optional().default("").describe("Description"),
			version: z.string().optional().default("1").describe("Version string"),
			providerName: z.string().describe("Provider/system name (e.g. 'VS7')"),
			basePath: z.string().describe("Base path prefix (e.g. '/vs7/orders/v1')"),
			targetUrl: z.string().describe("Backend target URL"),
			serviceCode: z.string().optional().default("ODATA").describe("Service code (default: ODATA)"),
		},
		async ({ name, title, description, version, providerName, basePath, targetUrl, serviceCode }) => {
			try {
				const proxyName = await createProxy({ name, title, description: description ?? "", version: version ?? "1", providerName, basePath, targetUrl, serviceCode });
				return {
					content: [{
						type: "text",
						text: `Proxy '${proxyName}' created successfully.`,
					}],
				};
			} catch (error) {
				return { isError: true, content: [formatError(error)] };
			}
		}
	);

	server.registerToolIntegrationSuite(
		"apim-deploy-proxy",
		`Deploy (activate) an SAP API Management proxy after changes.
Must be called after applying policies or creating a proxy to make it effective.`,
		{
			proxyName: z.string().describe("Exact proxy name to deploy"),
		},
		async ({ proxyName }) => {
			try {
				await deployProxy(proxyName);
				return {
					content: [{
						type: "text",
						text: `Proxy '${proxyName}' deployed successfully.`,
					}],
				};
			} catch (error) {
				return { isError: true, content: [formatError(error)] };
			}
		}
	);
};
