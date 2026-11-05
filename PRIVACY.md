# Privacy policy

Inkference has no server, no account, no analytics and no telemetry. The developers receive nothing.

## What leaves the browser, and where it goes

Inkference sends data to exactly one place: **the LLM gateway you configure** in its options
(default `http://127.0.0.1:8787`, an [lmgw](https://github.com/lmgw-dev/lmgw) instance on your own
machine). Nothing is sent until you set that up and use a feature that needs it.

What is sent, and when:

| Feature | Sent to your gateway | When |
| --- | --- | --- |
| Sidebar chat | your messages | when you send one |
| "Use page" agent | the page's text, its URL and title, a list of its controls; screenshots of the tab if you enable screen vision | while a task you started runs |
| Right-click actions | the selected text or the page's text | when you pick an action |
| Read aloud | the text you chose | when you start it |
| AI dark mode | a summary of the page's colours and CSS selectors | when a site is compiled with a model; without a model, nothing is sent |
| Script mode | the structure of the elements covering videos on the page | while you build a script with the agent |

If lmgw forwards a request to a cloud model you enabled, the gateway's and that provider's privacy
terms apply to that request. Inkference itself never contacts a cloud provider.

## Other network requests

AI dark mode reads the stylesheets of the page you're on. When a site loads a stylesheet from another
origin, Inkference fetches that stylesheet itself, like the page already did. Private network
addresses are refused unless the page itself is on one.

## Stored locally

Settings (gateway URL and API key, chosen models), the current conversation, compiled dark-mode
themes per site, and Script mode scripts are kept in the extension's local storage on your device.
Removing the extension deletes them.

## Contact

Questions: open an issue at <https://github.com/lmgw-dev/inkference/issues>.
