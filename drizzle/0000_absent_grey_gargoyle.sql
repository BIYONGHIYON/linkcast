CREATE TABLE `peers` (
	`room_id` text NOT NULL,
	`peer_id` text NOT NULL,
	`role` text NOT NULL,
	`last_seen_at` integer NOT NULL,
	PRIMARY KEY(`room_id`, `peer_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_peers_room_role` ON `peers` (`room_id`,`role`);--> statement-breakpoint
CREATE INDEX `idx_peers_last_seen_at` ON `peers` (`last_seen_at`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_rooms_expires_at` ON `rooms` (`expires_at`);--> statement-breakpoint
CREATE TABLE `signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_signals_recipient` ON `signals` (`room_id`,`recipient_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_signals_created_at` ON `signals` (`created_at`);
--> statement-breakpoint
PRAGMA optimize;
