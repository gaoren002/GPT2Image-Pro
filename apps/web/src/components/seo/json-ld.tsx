import {
  type BreadcrumbItem,
  type FAQItem,
  generateBreadcrumbSchema,
  generateFAQSchema,
  generateOrganizationSchema,
  generateSoftwareApplicationSchema,
  generateWebSiteSchema,
} from "@/lib/seo/json-ld";

type LocaleType = "en" | "zh";

/**
 * Generic JSON-LD script injector
 */
function JsonLdScript({ data }: { data: object }) {
  const serialized = JSON.stringify(data).replace(/</g, "\\u003c");
  return <script type="application/ld+json">{serialized}</script>;
}

/**
 * WebSite + Organization (typically used in layout)
 */
export function SiteJsonLd({ locale }: { locale: LocaleType }) {
  return (
    <>
      <JsonLdScript data={generateWebSiteSchema(locale)} />
      <JsonLdScript data={generateOrganizationSchema()} />
    </>
  );
}

/**
 * FAQ Page
 */
export function FAQJsonLd({ faqs }: { faqs: FAQItem[] }) {
  if (!faqs || faqs.length === 0) return null;
  return <JsonLdScript data={generateFAQSchema(faqs)} />;
}

/**
 * Breadcrumbs
 */
export function BreadcrumbJsonLd({ items }: { items: BreadcrumbItem[] }) {
  if (!items || items.length === 0) return null;
  return <JsonLdScript data={generateBreadcrumbSchema(items)} />;
}

/**
 * Software Application (for product pages)
 */
export function SoftwareAppJsonLd({ locale }: { locale: LocaleType }) {
  return <JsonLdScript data={generateSoftwareApplicationSchema(locale)} />;
}

/**
 * Combined schema for homepage
 */
export function HomePageJsonLd({
  locale,
  faqs,
}: {
  locale: LocaleType;
  faqs?: FAQItem[];
}) {
  return (
    <>
      <SiteJsonLd locale={locale} />
      <SoftwareAppJsonLd locale={locale} />
      {faqs && faqs.length > 0 && <FAQJsonLd faqs={faqs} />}
    </>
  );
}
