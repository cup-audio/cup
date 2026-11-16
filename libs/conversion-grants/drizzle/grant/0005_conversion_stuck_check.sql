ALTER TABLE `conversions` ADD `stage_started_at_ms` integer;--> statement-breakpoint
ALTER TABLE `conversions` ADD `stuck_reported_at_ms` integer;--> statement-breakpoint
-- Preparation started at acceptance, synthesis when the conversion became ready; a retry before this
-- migration is not recorded, so a retried conversion counts from its acceptance.
UPDATE `conversions` SET `stage_started_at_ms` = coalesce(`completed_at_ms`, `created_at_ms`);