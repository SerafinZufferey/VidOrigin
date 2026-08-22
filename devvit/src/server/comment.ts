export type ProviderLink = { name: string; url: string };

export function buildComment(subreddit: string, providers: ProviderLink[]): string {
  const links = providers.map(({name,url}) => `[${name}](${url})`).join(' | ');
  const modmail = `https://www.reddit.com/message/compose?to=%2Fr%2F${encodeURIComponent(subreddit)}`;
  return [
    'This is an automatic comment used to help identify possible sources of this post’s media.',
    '',
    '**Reverse Source Search:**',
    '',
    links,
    '',
    `I am a bot, and this action was performed automatically. [Please contact the moderators of this subreddit](${modmail}) if you have any questions or concerns.`,
    '',
    '*Search results may show earlier appearances or related images; they do not by themselves establish the original source.*'
  ].join('\n');
}
