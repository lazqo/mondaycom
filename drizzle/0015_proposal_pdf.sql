CREATE TABLE "catalogue_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"width" integer,
	"height" integer,
	"size" integer DEFAULT 0 NOT NULL,
	"sha256" text NOT NULL,
	"source_url" text,
	"content" "bytea" NOT NULL,
	"uploaded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"kind" text DEFAULT 'proposal' NOT NULL,
	"approval_hash" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text DEFAULT 'application/pdf' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"sha256" text NOT NULL,
	"data" jsonb NOT NULL,
	"content" "bytea" NOT NULL,
	"generated_by_id" uuid,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text
);
--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "quote_document_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "quote_display_name" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "quote_description" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "quote_highlights" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "quote_feature_notes" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "quote_image_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "quote_show_card" boolean;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "quote_content_status" "knowledge_status" DEFAULT 'requires_review' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "quote_content_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "catalogue_images" ADD CONSTRAINT "catalogue_images_uploaded_by_id_users_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_documents" ADD CONSTRAINT "quote_documents_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_documents" ADD CONSTRAINT "quote_documents_generated_by_id_users_id_fk" FOREIGN KEY ("generated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quote_documents_quote_idx" ON "quote_documents" USING btree ("quote_id","generated_at");--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_quote_document_id_quote_documents_id_fk" FOREIGN KEY ("quote_document_id") REFERENCES "public"."quote_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_quote_image_id_catalogue_images_id_fk" FOREIGN KEY ("quote_image_id") REFERENCES "public"."catalogue_images"("id") ON DELETE set null ON UPDATE no action;