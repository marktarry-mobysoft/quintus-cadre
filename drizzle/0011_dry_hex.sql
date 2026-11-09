ALTER TABLE `coupons` ADD `revoked_at` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `completed_lessons_at_request` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `refunds` ADD `total_lessons_at_request` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `refunds` ADD `watched_seconds_at_request` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `refunds` ADD `decline_reason` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `refund_state` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `issued_at` text;