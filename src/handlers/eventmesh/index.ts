import { z } from "zod";
import { McpServerWithMiddleware } from "../../utils/middleware";
import { formatError } from "../../utils/customErrHandler";
import {
	publishToTopic,
	consumeFromQueue,
	listNamespaces,
	listQueues,
	getQueueDetails,
	listQueueSubscriptions,
	listTopicSubscriptions,
} from "../../api/eventmesh";

export const registerEventMeshHandlers = (server: McpServerWithMiddleware) => {
	server.registerToolIntegrationSuite(
		"aem-publish-topic",
		`Publish a message to a SAP Event Mesh topic via the REST gateway.
Use this to trigger integration flows or test event-driven scenarios.
Note: only flat topic names work (no slashes). Hierarchical names like "sap/s4/orders" are not supported by the REST gateway.
Returns confirmation of successful publish (HTTP 204).`,
		{
			topicName: z.string().describe("Topic name (flat, no slashes, e.g. 'testTopic')"),
			payload: z.string().describe("Message body to publish"),
			contentType: z.string().optional().default("application/json").describe(
				"Content-Type of the message (default: application/json)"
			),
		},
		async ({ topicName, payload, contentType }) => {
			try {
				await publishToTopic(topicName, payload, contentType ?? "application/json");
				return {
					content: [{ type: "text", text: `Message published to topic '${topicName}' successfully.` }],
				};
			} catch (error) {
				return { isError: true, content: [formatError(error)] };
			}
		}
	);

	server.registerToolIntegrationSuite(
		"aem-list-namespaces",
		`List all namespaces configured in SAP Event Mesh.
A namespace groups queues and topic subscriptions. Use this first to discover the namespace name needed for other monitoring tools.`,
		{},
		async () => {
			try {
				const result = await listNamespaces();
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return { isError: true, content: [formatError(error)] };
			}
		}
	);

	server.registerToolIntegrationSuite(
		"aem-list-queues",
		`List all queues in a SAP Event Mesh namespace with their statistics.
Shows queue depth (number of messages waiting), max message count, and consumer count.
Use aem-list-namespaces first to get the namespace name.`,
		{
			namespace: z.string().describe("Namespace name (from aem-list-namespaces)"),
		},
		async ({ namespace }) => {
			try {
				const result = await listQueues(namespace);
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return { isError: true, content: [formatError(error)] };
			}
		}
	);

	server.registerToolIntegrationSuite(
		"aem-queue-details",
		`Get detailed statistics for a specific SAP Event Mesh queue.
Returns queue depth, message count, consumer info, and configuration.`,
		{
			namespace: z.string().describe("Namespace name"),
			queueName: z.string().describe("Queue name"),
		},
		async ({ namespace, queueName }) => {
			try {
				const [details, subscriptions] = await Promise.all([
					getQueueDetails(namespace, queueName),
					listQueueSubscriptions(namespace, queueName),
				]);
				return {
					content: [{
						type: "text",
						text: JSON.stringify({ details, subscriptions }, null, 2),
					}],
				};
			} catch (error) {
				return { isError: true, content: [formatError(error)] };
			}
		}
	);

	server.registerToolIntegrationSuite(
		"aem-list-topic-subscriptions",
		`List all topic subscriptions in a SAP Event Mesh namespace.
Shows which topics are routed to which queues — useful for tracing event flows end-to-end.`,
		{
			namespace: z.string().describe("Namespace name"),
		},
		async ({ namespace }) => {
			try {
				const result = await listTopicSubscriptions(namespace);
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
			} catch (error) {
				return { isError: true, content: [formatError(error)] };
			}
		}
	);

	server.registerToolIntegrationSuite(
		"aem-consume-queue",
		`Consume one message from a SAP Event Mesh queue via the REST gateway.
Uses QoS 0 (at-most-once) — the message is auto-deleted from the queue after reading.
Use this to inspect or debug messages waiting in a queue.
Returns the message payload and headers, or indicates the queue is empty.
WARNING: this permanently removes the message from the queue.`,
		{
			queueName: z.string().describe("Queue name to consume from"),
		},
		async ({ queueName }) => {
			try {
				const result = await consumeFromQueue(queueName);
				if (result.empty) {
					return {
						content: [{ type: "text", text: `Queue '${queueName}' is empty (no messages).` }],
					};
				}
				const output = {
					queueName,
					contentType: result.contentType,
					payload: result.payload,
					headers: result.headers,
				};
				return {
					content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
				};
			} catch (error) {
				return { isError: true, content: [formatError(error)] };
			}
		}
	);
};
