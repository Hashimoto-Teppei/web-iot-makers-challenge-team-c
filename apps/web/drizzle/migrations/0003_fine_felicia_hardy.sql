CREATE TABLE `detections` (
	`device_id` text NOT NULL,
	`source` text NOT NULL,
	`log_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`lv` integer NOT NULL,
	`t` integer NOT NULL,
	`t_est` integer DEFAULT false NOT NULL,
	`sample` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`device_id`, `source`, `log_id`, `seq`)
);
--> statement-breakpoint
CREATE INDEX `detections_device_t_idx` ON `detections` (`device_id`,`t`);--> statement-breakpoint
CREATE TABLE `ride_points` (
	`device_id` text NOT NULL,
	`log_id` text NOT NULL,
	`seq` integer NOT NULL,
	`t` integer NOT NULL,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`spd` real NOT NULL,
	`crs` real,
	`hacc` real NOT NULL,
	PRIMARY KEY(`device_id`, `log_id`, `seq`)
);
--> statement-breakpoint
CREATE INDEX `ride_points_device_t_idx` ON `ride_points` (`device_id`,`t`);--> statement-breakpoint
CREATE TABLE `rides` (
	`device_id` text NOT NULL,
	`log_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`sample` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`device_id`, `log_id`)
);
--> statement-breakpoint
CREATE INDEX `rides_started_at_idx` ON `rides` (`started_at`);--> statement-breakpoint
CREATE TABLE `stop_violations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` text NOT NULL,
	`log_id` text NOT NULL,
	`sign_id` text NOT NULL,
	`t` integer NOT NULL,
	`thr_stop_speed_mps` real NOT NULL,
	`thr_radius_m` real NOT NULL,
	`thr_bearing_tolerance_deg` real NOT NULL,
	`computed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stop_violations_ride_idx` ON `stop_violations` (`device_id`,`log_id`);