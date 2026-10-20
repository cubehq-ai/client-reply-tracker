/**
 * Turns Slack's wire markup into what a person sees in Slack.
 *
 * Message text arrives with mentions, channels and links as markup --
 * <@U0359TLU8HM>, <#C123|general>, <https://x.test|label> -- which Slack
 * renders client-side. Shown raw, a summary reads as an id soup and the
 * person the message is addressed to is unreadable.
 */
export function renderSlackText(text: string, names: Map<string, string>): string {
  return text
    // <@U123> and <@U123|fallback>
    .replace(/<@([A-Z0-9_]+)(?:\|([^>]*))?>/g, (_m, id: string, fallback?: string) =>
      `@${names.get(id) ?? (fallback && fallback !== '' ? fallback : id)}`)
    // <#C123|name> and <#C123>
    .replace(/<#([A-Z0-9_]+)(?:\|([^>]*))?>/g, (_m, id: string, name?: string) =>
      `#${name && name !== '' ? name : (names.get(id) ?? id)}`)
    // <!here>, <!channel>, <!subteam^S123|@team>
    .replace(/<!subteam\^[A-Z0-9]+(?:\|@?([^>]*))?>/g, (_m, name?: string) => `@${name || 'team'}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_m, kind: string) => `@${kind}`)
    // <https://x.test|label> keeps the label; a bare link keeps the url
    .replace(/<(https?:\/\/[^>|]+)(?:\|([^>]*))?>/g, (_m, url: string, label?: string) => label || url)
    .replace(/<mailto:([^>|]+)(?:\|([^>]*))?>/g, (_m, addr: string, label?: string) => label || addr)
    // Slack escapes these three in the wire format.
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}
