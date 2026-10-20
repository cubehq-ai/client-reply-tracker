/**
 * Slack ships emoji as shortcodes (`:eyes:`), which it renders client-side.
 * Left alone they read as punctuation, and a reaction row becomes
 * ":eyes: 1  :done-2: 1".
 *
 * Only the common ones are mapped. A workspace's custom emoji -- `done-2`
 * here -- has no Unicode form at all, so it falls back to its name without
 * the colons, which at least reads as a word.
 */
const EMOJI: Record<string, string> = {
  '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎',
  eyes: '👀', wave: '👋', pray: '🙏', clap: '👏', raised_hands: '🙌',
  ok_hand: '👌', muscle: '💪', point_up: '☝️', point_right: '👉',
  white_check_mark: '✅', heavy_check_mark: '✔️', ballot_box_with_check: '☑️',
  x: '❌', heavy_multiplication_x: '✖️', warning: '⚠️', no_entry: '⛔',
  exclamation: '❗', question: '❓', bangbang: '‼️',
  smile: '😄', smiley: '😃', grinning: '😀', blush: '😊', wink: '😉',
  laughing: '😆', joy: '😂', rofl: '🤣', slightly_smiling_face: '🙂',
  upside_down_face: '🙃', thinking_face: '🤔', neutral_face: '😐',
  expressionless: '😑', confused: '😕', worried: '😟', cry: '😢',
  sob: '😭', scream: '😱', flushed: '😳', sweat_smile: '😅',
  smiling_face_with_3_hearts: '🥰', heart_eyes: '😍', kissing_heart: '😘',
  sunglasses: '😎', nerd_face: '🤓', partying_face: '🥳', zany_face: '🤪',
  heart: '❤️', hearts: '💕', sparkling_heart: '💖', broken_heart: '💔',
  fire: '🔥', star: '⭐', star2: '🌟', sparkles: '✨', zap: '⚡',
  boom: '💥', tada: '🎉', confetti_ball: '🎊', gift: '🎁', trophy: '🏆',
  rocket: '🚀', airplane: '✈️', car: '🚗', hourglass: '⌛',
  alarm_clock: '⏰', clock: '🕐', calendar: '📅', date: '📆',
  email: '📧', envelope: '✉️', inbox_tray: '📥', outbox_tray: '📤',
  phone: '📞', telephone_receiver: '📞', iphone: '📱', computer: '💻',
  bulb: '💡', mag: '🔍', lock: '🔒', unlock: '🔓', key: '🔑',
  link: '🔗', paperclip: '📎', pushpin: '📌', round_pushpin: '📍',
  memo: '📝', pencil: '✏️', clipboard: '📋', file_folder: '📁',
  chart_with_upwards_trend: '📈', chart_with_downwards_trend: '📉',
  bar_chart: '📊', moneybag: '💰', dollar: '💵', credit_card: '💳',
  bell: '🔔', loudspeaker: '📢', mega: '📣', speech_balloon: '💬',
  eyeglasses: '👓', coffee: '☕', beer: '🍺', pizza: '🍕', cake: '🍰',
  sun_with_face: '🌞', sunny: '☀️', cloud: '☁️', rain_cloud: '🌧️',
  snowflake: '❄️', earth_americas: '🌎', seedling: '🌱', herb: '🌿',
  green_circle: '🟢', red_circle: '🔴', large_blue_circle: '🔵',
  yellow_circle: '🟡', orange_circle: '🟠', white_circle: '⚪', black_circle: '⚫',
  arrow_right: '➡️', arrow_left: '⬅️', arrow_up: '⬆️', arrow_down: '⬇️',
  recycle: '♻️', repeat: '🔁', arrows_counterclockwise: '🔄',
  hammer: '🔨', wrench: '🔧', gear: '⚙️', construction: '🚧',
  bug: '🐛', robot_face: '🤖', ghost: '👻', skull: '💀',
  hugging_face: '🤗', face_with_monocle: '🧐', saluting_face: '🫡',
  handshake: '🤝', raised_hand: '✋', crossed_fingers: '🤞',
  eye: '👁️', ear: '👂', brain: '🧠',100: '💯', ok: '🆗', new: '🆕',
};

/** The emoji for a shortcode, or null when the workspace made it up. */
export function emojiFor(name: string): string | null {
  const base = name.replace(/::skin-tone-\d+$/, '');
  return EMOJI[base] ?? null;
}

/** Replaces `:shortcode:` in message text with the emoji it stands for. */
export function renderEmoji(text: string): string {
  return text.replace(/:([a-z0-9_+-]+(?:::skin-tone-\d+)?):/gi, (whole, name: string) =>
    emojiFor(name.toLowerCase()) ?? whole);
}

/** A reaction's label: the emoji, or its name without the colon soup. */
export function reactionLabel(name: string): string {
  return emojiFor(name.toLowerCase()) ?? name.replace(/[-_]/g, ' ');
}
