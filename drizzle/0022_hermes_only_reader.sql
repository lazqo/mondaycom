ALTER TYPE "public"."email_classification" ADD VALUE 'reading' BEFORE 'lead';--> statement-breakpoint
DROP TABLE "email_classifications" CASCADE;--> statement-breakpoint
DROP TABLE "jev_observations" CASCADE;