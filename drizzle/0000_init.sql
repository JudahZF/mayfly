CREATE TABLE `bridge_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`entry_id` text,
	`source` text NOT NULL,
	`detail` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bridge_log_at` ON `bridge_log` (`at`);--> statement-breakpoint
CREATE TABLE `entries` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`start_time` text,
	`centihours` integer NOT NULL,
	`where` text NOT NULL,
	`method` text NOT NULL,
	`describe` text NOT NULL,
	`reflect` text NOT NULL,
	`anything_else` text,
	`ksbs` text NOT NULL,
	`source` text NOT NULL,
	`maytas_row_id` text,
	`fingerprint` text NOT NULL,
	`sync` text NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entries_maytasRowId_unique` ON `entries` (`maytas_row_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `entries_live_fingerprint` ON `entries` (`fingerprint`) WHERE "entries"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `entries_date` ON `entries` (`date`);--> statement-breakpoint
CREATE TABLE `profile` (
	`id` integer PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`agent_mode` text DEFAULT 'drafts' NOT NULL,
	`sync_paused` integer DEFAULT false NOT NULL,
	`bridge_paused_reason` text,
	`bridge_paused_at` integer,
	`sign_in_failures` integer DEFAULT 0 NOT NULL,
	`last_reconcile_at` integer
);
