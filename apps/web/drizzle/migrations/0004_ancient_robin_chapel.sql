-- 不停止（#85）が、判定から外した測位精度の下限（`thr_max_hacc_m`）を記録するようにした。
--
-- **drizzle-kit が出した `ALTER TABLE ... ADD COLUMN ... NOT NULL` を、作り直しに置き換えてある。**
-- SQLite は **NOT NULL の列を既定値なしで足せない**（行が1つも無くてもエラーになる）。
-- **既定値を付けて逃げない**——この列は「どの設定で作られた行か」の記録であり、
-- **誰も選んでいない数字が入った行は、作り直す判断の根拠にならない。**
--
-- **作り直してよいのは、この表がサーバーの計算結果で、何度でも作り直せるから**である
-- （`src/worker/db/schema.ts`）。中身を入れるのは #85 が最初なので、消えるものは無い。
DROP TABLE `stop_violations`;--> statement-breakpoint
CREATE TABLE `stop_violations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` text NOT NULL,
	`log_id` text NOT NULL,
	`sign_id` text NOT NULL,
	`t` integer NOT NULL,
	`thr_stop_speed_mps` real NOT NULL,
	`thr_radius_m` real NOT NULL,
	`thr_bearing_tolerance_deg` real NOT NULL,
	`thr_max_hacc_m` real NOT NULL,
	`computed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stop_violations_ride_idx` ON `stop_violations` (`device_id`,`log_id`);
