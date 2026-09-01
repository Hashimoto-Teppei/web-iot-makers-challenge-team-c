CREATE TABLE `stop_sign_versions` (
	`pref` integer PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`count` integer NOT NULL,
	`imported_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stop_signs` (
	`id` text PRIMARY KEY NOT NULL,
	`pref` integer NOT NULL,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`approach_lat` real,
	`approach_lon` real,
	`name` text
);
--> statement-breakpoint
CREATE INDEX `stop_signs_pref_idx` ON `stop_signs` (`pref`);