import { Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { RequestWithAuth, WEBHOOK_EVENT_TYPES } from "@anycrawl/libs";
import { getDB, schemas, eq, sql } from "@anycrawl/db";
import { log } from "@anycrawl/libs";
import { randomUUID } from "crypto";
import { serializeRecord, serializeRecords } from "../../utils/serializer.js";

// Validation schemas
const createWebhookSchema = z.object({
    name: z.string().min(1).max(255),
    description: z.string().optional(),
    webhook_url: z.string().url(),
    event_types: z.array(z.string()).min(1).refine(
        (types) => types.every((type) => (WEBHOOK_EVENT_TYPES as readonly string[]).includes(type)),
        "Invalid event type"
    ),
    scope: z.enum(["all", "specific"]).default("all"),
    specific_task_ids: z.array(z.string().uuid()).optional(),
    custom_headers: z.record(z.string()).optional(),
    timeout_seconds: z.number().int().min(1).max(60).default(10),
    max_retries: z.number().int().min(0).max(10).default(3),
    retry_backoff_multiplier: z.number().min(1).max(10).default(2),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.any()).optional(),
});

const updateWebhookSchema = createWebhookSchema.partial();

export class WebhooksController {
    /**
     * Create a new webhook subscription
     */
    public create = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const validatedData = createWebhookSchema.parse(req.body);
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;
            // Validate scope and specific_task_ids
            if (validatedData.scope === "specific" && (!validatedData.specific_task_ids || validatedData.specific_task_ids.length === 0)) {
                res.status(400).json({
                    success: false,
                    error: "specific_task_ids is required when scope is 'specific'",
                });
                return;
            }

            const db = await getDB();
            const webhookUuid = randomUUID();
            const secret = crypto.randomBytes(32).toString("hex");

            // Store both apiKey and userId (dual field storage)
            await db.insert(schemas.webhookSubscriptions).values({
                uuid: webhookUuid,
                apiKey: apiKeyId,                    // Track which API key created this webhook
                userId: (userId || null) as any,    // Track which user owns this webhook (can be null)
                name: validatedData.name,
                description: validatedData.description,
                webhookUrl: validatedData.webhook_url,
                webhookSecret: secret,
                scope: validatedData.scope,
                specificTaskIds: validatedData.specific_task_ids,
                eventTypes: validatedData.event_types,
                customHeaders: validatedData.custom_headers,
                timeoutSeconds: validatedData.timeout_seconds,
                maxRetries: validatedData.max_retries,
                retryBackoffMultiplier: validatedData.retry_backoff_multiplier,
                isActive: true,
                tags: validatedData.tags,
                metadata: validatedData.metadata,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            res.status(201).json({
                success: true,
                data: {
                    webhook_id: webhookUuid,
                    secret: secret, // Only shown once during creation
                    message: "Webhook created successfully. Save the secret - it won't be shown again.",
                },
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * List all webhook subscriptions for the authenticated API key
     */
    public list = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;
            const db = await getDB();

            // Query by userId if exists, otherwise by apiKey, otherwise all webhooks
            const webhooks = userId
                ? await db
                    .select()
                    .from(schemas.webhookSubscriptions)
                    .where(eq(schemas.webhookSubscriptions.userId, userId))
                    .orderBy(sql`${schemas.webhookSubscriptions.createdAt} DESC`)
                : apiKeyId
                ? await db
                    .select()
                    .from(schemas.webhookSubscriptions)
                    .where(eq(schemas.webhookSubscriptions.apiKey, apiKeyId))
                    .orderBy(sql`${schemas.webhookSubscriptions.createdAt} DESC`)
                : await db
                    .select()
                    .from(schemas.webhookSubscriptions)
                    .orderBy(sql`${schemas.webhookSubscriptions.createdAt} DESC`);

            // Hide the secret in list view and convert to snake_case
            const sanitized = webhooks.map((w: any) => ({
                ...w,
                webhookSecret: "***hidden***",
            }));
            const serialized = serializeRecords(sanitized);

            res.json({
                success: true,
                data: serialized,
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Get a specific webhook subscription
     */
    public get = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { webhookId } = req.params;
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;
            const db = await getDB();

            // Check ownership by userId if exists, otherwise by apiKey, or just by webhookId if no auth
            const whereClause = userId
                ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.apiKey} = ${apiKeyId}`
                : sql`${schemas.webhookSubscriptions.uuid} = ${webhookId}`;

            const webhook = await db
                .select()
                .from(schemas.webhookSubscriptions)
                .where(whereClause)
                .limit(1);

            if (!webhook.length) {
                res.status(404).json({
                    success: false,
                    error: "Webhook not found",
                });
                return;
            }

            // Hide the secret and convert to snake_case
            const sanitized = {
                ...webhook[0],
                webhookSecret: "***hidden***",
            };
            const serialized = serializeRecord(sanitized);

            res.json({
                success: true,
                data: serialized,
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Update a webhook subscription
     */
    public update = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { webhookId } = req.params;
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;
            const validatedData = updateWebhookSchema.parse(req.body);
            const db = await getDB();

            // Check webhook exists and belongs to user/apiKey, or just check existence if no auth
            const whereClause = userId
                ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.apiKey} = ${apiKeyId}`
                : sql`${schemas.webhookSubscriptions.uuid} = ${webhookId}`;

            const existing = await db
                .select()
                .from(schemas.webhookSubscriptions)
                .where(whereClause)
                .limit(1);

            if (!existing.length) {
                res.status(404).json({
                    success: false,
                    error: "Webhook not found",
                });
                return;
            }

            const updateData: any = {
                ...validatedData,
                updatedAt: new Date(),
            };

            // Map snake_case to camelCase
            if (validatedData.webhook_url) updateData.webhookUrl = validatedData.webhook_url;
            if (validatedData.event_types) updateData.eventTypes = validatedData.event_types;
            if (validatedData.specific_task_ids) updateData.specificTaskIds = validatedData.specific_task_ids;
            if (validatedData.custom_headers) updateData.customHeaders = validatedData.custom_headers;
            if (validatedData.timeout_seconds) updateData.timeoutSeconds = validatedData.timeout_seconds;
            if (validatedData.max_retries !== undefined) updateData.maxRetries = validatedData.max_retries;
            if (validatedData.retry_backoff_multiplier !== undefined) updateData.retryBackoffMultiplier = validatedData.retry_backoff_multiplier;

            // Remove snake_case fields
            delete updateData.webhook_url;
            delete updateData.event_types;
            delete updateData.specific_task_ids;
            delete updateData.custom_headers;
            delete updateData.timeout_seconds;
            delete updateData.max_retries;
            delete updateData.retry_backoff_multiplier;

            await db
                .update(schemas.webhookSubscriptions)
                .set(updateData)
                .where(eq(schemas.webhookSubscriptions.uuid, webhookId));

            res.json({
                success: true,
                message: "Webhook updated successfully",
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Delete a webhook subscription
     */
    public delete = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { webhookId } = req.params;
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;
            const db = await getDB();

            const whereClause = userId
                ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.apiKey} = ${apiKeyId}`
                : sql`${schemas.webhookSubscriptions.uuid} = ${webhookId}`;

            await db
                .delete(schemas.webhookSubscriptions)
                .where(whereClause);

            res.json({
                success: true,
                message: "Webhook deleted successfully",
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Get delivery history for a webhook
     */
    public deliveries = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { webhookId } = req.params;
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;
            const limit = parseInt(req.query.limit as string) || 100;
            const offset = parseInt(req.query.offset as string) || 0;
            const status = req.query.status as string;
            const from = req.query.from as string;
            const to = req.query.to as string;
            const db = await getDB();

            // Verify webhook belongs to user/apiKey, or just by webhookId if no auth
            const whereClause = userId
                ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.apiKey} = ${apiKeyId}`
                : sql`${schemas.webhookSubscriptions.uuid} = ${webhookId}`;

            const webhook = await db
                .select()
                .from(schemas.webhookSubscriptions)
                .where(whereClause)
                .limit(1);

            if (!webhook.length) {
                res.status(404).json({
                    success: false,
                    error: "Webhook not found",
                });
                return;
            }

            // Build filter conditions
            const filters = [eq(schemas.webhookDeliveries.webhookSubscriptionUuid, webhookId)];

            if (status) {
                filters.push(eq(schemas.webhookDeliveries.status, status));
            }

            if (from) {
                filters.push(sql`${schemas.webhookDeliveries.createdAt} >= ${new Date(from)}`);
            }

            if (to) {
                filters.push(sql`${schemas.webhookDeliveries.createdAt} <= ${new Date(to)}`);
            }

            const deliveries = await db
                .select()
                .from(schemas.webhookDeliveries)
                .where(sql`${sql.join(filters, sql` AND `)}`)
                .orderBy(sql`${schemas.webhookDeliveries.createdAt} DESC`)
                .limit(limit)
                .offset(offset);

            // Convert to snake_case
            const serialized = serializeRecords(deliveries);

            res.json({
                success: true,
                data: serialized,
                meta: {
                    limit,
                    offset,
                    filters: {
                        status: status || null,
                        from: from || null,
                        to: to || null,
                    },
                },
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Send a test webhook
     */
    public test = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { webhookId } = req.params;
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;
            const db = await getDB();

            // Verify webhook belongs to user/apiKey, or just by webhookId if no auth
            const whereClause = userId
                ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.apiKey} = ${apiKeyId}`
                : sql`${schemas.webhookSubscriptions.uuid} = ${webhookId}`;

            const webhook = await db
                .select()
                .from(schemas.webhookSubscriptions)
                .where(whereClause)
                .limit(1);

            if (!webhook.length) {
                res.status(404).json({
                    success: false,
                    error: "Webhook not found",
                });
                return;
            }

            // Trigger test webhook
            try {
                const { WebhookManager } = await import("@anycrawl/scrape");
                await WebhookManager.getInstance().triggerEvent(
                    "webhook.test",
                    {
                        message: "This is a test webhook from AnyCrawl",
                        timestamp: new Date().toISOString(),
                        webhook_id: webhookId,
                    },
                    "webhook",
                    webhookId!,
                    userId || apiKeyId  // Use userId if exists, otherwise apiKeyId
                );

                res.json({
                    success: true,
                    message: "Test webhook triggered successfully",
                });
            } catch (error) {
                log.error(`Failed to trigger test webhook: ${error}`);
                res.status(500).json({
                    success: false,
                    error: "Failed to trigger webhook",
                    message: error instanceof Error ? error.message : "Unknown error",
                });
            }
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Activate a webhook subscription
     */
    public activate = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { webhookId } = req.params;
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;
            const db = await getDB();

            const whereClause = userId
                ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.apiKey} = ${apiKeyId}`
                : sql`${schemas.webhookSubscriptions.uuid} = ${webhookId}`;

            await db
                .update(schemas.webhookSubscriptions)
                .set({
                    isActive: true,
                    consecutiveFailures: 0,
                    updatedAt: new Date(),
                })
                .where(whereClause);

            res.json({
                success: true,
                message: "Webhook activated successfully",
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Deactivate a webhook subscription
     */
    public deactivate = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { webhookId } = req.params;
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;
            const db = await getDB();

            const whereClause = userId
                ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.apiKey} = ${apiKeyId}`
                : sql`${schemas.webhookSubscriptions.uuid} = ${webhookId}`;

            await db
                .update(schemas.webhookSubscriptions)
                .set({
                    isActive: false,
                    updatedAt: new Date(),
                })
                .where(whereClause);

            res.json({
                success: true,
                message: "Webhook deactivated successfully",
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Replay a failed webhook delivery
     */
    public replayDelivery = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { webhookId, deliveryId } = req.params;
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;
            const db = await getDB();

            // Verify webhook belongs to user
            const whereClause = userId
                ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.apiKey} = ${apiKeyId}`
                : sql`${schemas.webhookSubscriptions.uuid} = ${webhookId}`;

            const webhook = await db
                .select()
                .from(schemas.webhookSubscriptions)
                .where(whereClause)
                .limit(1);

            if (!webhook.length) {
                res.status(404).json({
                    success: false,
                    error: "Webhook not found",
                });
                return;
            }

            // Get the delivery
            const delivery = await db
                .select()
                .from(schemas.webhookDeliveries)
                .where(
                    sql`${schemas.webhookDeliveries.uuid} = ${deliveryId}
                        AND ${schemas.webhookDeliveries.webhookSubscriptionUuid} = ${webhookId}`
                )
                .limit(1);

            if (!delivery.length) {
                res.status(404).json({
                    success: false,
                    error: "Delivery not found",
                });
                return;
            }

            // Reset delivery for retry
            await db
                .update(schemas.webhookDeliveries)
                .set({
                    status: "pending",
                    attemptNumber: 1,
                    errorMessage: null,
                    nextRetryAt: null,
                })
                .where(eq(schemas.webhookDeliveries.uuid, deliveryId));

            // Re-enqueue for delivery
            const { QueueManager } = await import("@anycrawl/scrape");
            const queueManager = QueueManager.getInstance();
            const queue = queueManager.getQueue("webhooks");
            await queue.add(
                "webhook-delivery",
                { deliveryId: deliveryId },
                { jobId: `${deliveryId}-replay` }
            );

            res.json({
                success: true,
                message: "Webhook delivery replayed successfully",
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Get supported webhook event types
     */
    public getEvents = async (_req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            res.json({
                success: true,
                data: {
                    event_types: WEBHOOK_EVENT_TYPES,
                    categories: {
                        scrape: WEBHOOK_EVENT_TYPES.filter((e: string) => e.startsWith("scrape.")),
                        crawl: WEBHOOK_EVENT_TYPES.filter((e: string) => e.startsWith("crawl.")),
                        search: WEBHOOK_EVENT_TYPES.filter((e: string) => e.startsWith("search.")),
                        scheduled_tasks: WEBHOOK_EVENT_TYPES.filter((e: string) => e.startsWith("task.")),
                        webhook: WEBHOOK_EVENT_TYPES.filter((e: string) => e.startsWith("webhook.")),
                    },
                },
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    private handleError(error: any, res: Response): void {
        if (error instanceof z.ZodError) {
            const formattedErrors = error.errors.map((err) => ({
                field: err.path.join("."),
                message: err.message,
                code: err.code,
            }));
            const message = error.errors.map((err) => err.message).join(", ");
            res.status(400).json({
                success: false,
                error: "Validation error",
                message: message,
                details: formattedErrors,
            });
        } else {
            log.error(`Webhooks controller error: ${error}`);
            res.status(500).json({
                success: false,
                error: "Internal server error",
                message: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }
}
