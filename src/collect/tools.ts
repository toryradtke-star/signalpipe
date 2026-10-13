/**
 * Go-to-market tools signalpipe can recognize, two ways:
 *
 * - `script`: a fingerprint in a site's raw HTML (a script host or a global it
 *   defines). Seeing it is direct evidence the tool is installed today.
 * - `text`: the tool named in a job post ("experience with Clay"). Weaker - it
 *   says the team uses it or wants it - and is recorded as such.
 *
 * Keys are what profiles weight as `tool:<key>`.
 */
export type ToolDef = { name: string; script?: RegExp; text?: RegExp };

export const TOOLS: Record<string, ToolDef> = {
  hubspot: { name: 'HubSpot', script: /js\.hs-scripts\.com|js\.hsforms\.net|js\.hs-analytics\.net|hs-banner\.com/i, text: /\bhubspot\b/i },
  salesforce: { name: 'Salesforce', script: /force\.com\/|salesforceliveagent|my\.salesforce-sites\.com/i, text: /\bsalesforce\b|\bsfdc\b/i },
  pardot: { name: 'Pardot / Account Engagement', script: /pi\.pardot\.com|go\.pardot\.com/i, text: /\bpardot\b/i },
  marketo: { name: 'Marketo', script: /munchkin\.marketo\.net|mktoForms|marketo\.com\/js/i, text: /\bmarketo\b/i },
  segment: { name: 'Segment', script: /cdn\.segment\.com|analytics\.segment\.io/i, text: /\bsegment(\.com| cdp)\b/i },
  clay: { name: 'Clay', text: /\bclay(\.com)?\b(?!\s*(court|pot|tile))/i },
  apollo: { name: 'Apollo', script: /assets\.apollo\.io/i, text: /\bapollo(\.io)?\b/i },
  outreach: { name: 'Outreach', text: /\boutreach\.io\b|\boutreach\b(?=[^.]{0,40}\b(salesloft|sequenc|cadence))/i },
  salesloft: { name: 'Salesloft', script: /scout-cdn\.salesloft\.com/i, text: /\bsalesloft\b/i },
  gong: { name: 'Gong', text: /\bgong(\.io)?\b/i },
  sixsense: { name: '6sense', script: /j\.6sc\.co|6sense/i, text: /\b6sense\b/i },
  demandbase: { name: 'Demandbase', script: /tag\.demandbase\.com/i, text: /\bdemandbase\b/i },
  clearbit: { name: 'Clearbit', script: /tag\.clearbitscripts\.com|reveal\.clearbit\.com/i, text: /\bclearbit\b/i },
  koala: { name: 'Koala', script: /cdn\.getkoala\.com/i },
  commonroom: { name: 'Common Room', script: /cdn\.cr-relay\.com/i, text: /\bcommon room\b/i },
  rb2b: { name: 'RB2B', script: /rb2b\.com|ddwl4m2hdecbv\.cloudfront\.net/i, text: /\brb2b\b/i },
  warmly: { name: 'Warmly', script: /opps-widget\.getwarmly\.com/i, text: /\bwarmly\b/i },
  mutiny: { name: 'Mutiny', script: /mutinycdn\.com|mutinyhq/i, text: /\bmutiny\b/i },
  qualified: { name: 'Qualified', script: /js\.qualified\.com/i },
  chilipiper: { name: 'Chili Piper', script: /js\.chilipiper\.com/i, text: /\bchili ?piper\b/i },
  drift: { name: 'Drift', script: /js\.driftt\.com/i },
  intercom: { name: 'Intercom', script: /widget\.intercom\.io|js\.intercomcdn\.com/i },
  gtm: { name: 'Google Tag Manager', script: /googletagmanager\.com\/gtm\.js/i },
  n8n: { name: 'n8n', text: /\bn8n\b/i },
  zapier: { name: 'Zapier', text: /\bzapier\b/i },
  make: { name: 'Make', text: /\bmake\.com\b/i },
  snowflake: { name: 'Snowflake', text: /\bsnowflake\b/i },
  dbt: { name: 'dbt', text: /\bdbt\b/i },
  hightouch: { name: 'Hightouch', text: /\bhightouch\b/i },
  census: { name: 'Census', text: /\bcensus\b(?= ?(reverse|sync|etl))|getcensus/i },
  llm: { name: 'LLMs / AI agents', text: /\b(llms?|openai|anthropic|claude|gpt-?\d|ai agents?|agentic)\b/i },
};
