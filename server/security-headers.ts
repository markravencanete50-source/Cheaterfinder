/** Enable HTTPS persistence only for a verified HTTPS production deployment.
 * Start with one day and host-only scope; do not preload or change sibling
 * subdomains. Local HTTP development must remain usable.
 */
export function productionHstsOptions(env: NodeJS.ProcessEnv = process.env) {
  return env.NODE_ENV === "production" && env.HTTPS_ENABLED === "true"
    ? { maxAge: 86_400, includeSubDomains: false, preload: false }
    : false;
}
