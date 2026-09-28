// Як оформити сповіщення про витрату в Telegram залежно від кількості фото квитанцій.
// Повертає кроки — виклики Bot API; фото позначені як { photo: i } (i — номер фото), їх підставляє index.ts.

export const CAPTION_LIMIT = 1024; // Telegram обмежує підпис до фото (разом з розміткою — з запасом)

export function planExpenseMessage({ chatId, text, buttons, photoCount }) {
  const message = {
    method: 'sendMessage',
    params: { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: buttons, link_preview_options: { is_disabled: true } },
  };
  if (!photoCount) return [message];
  // Одне фото — одне повідомлення: фото, під ним текст і кнопки.
  if (photoCount === 1 && text.length <= CAPTION_LIMIT) {
    return [{
      method: 'sendPhoto',
      params: { chat_id: chatId, photo: { photo: 0 }, caption: text, parse_mode: 'HTML', reply_markup: buttons },
    }];
  }
  // Кілька фото — альбом (під альбомом кнопок бути не може), одразу під ним текст з кнопками.
  const album = photoCount === 1
    ? { method: 'sendPhoto', params: { chat_id: chatId, photo: { photo: 0 }, disable_notification: true } }
    : {
      method: 'sendMediaGroup',
      params: {
        chat_id: chatId,
        media: Array.from({ length: photoCount }, (_, i) => ({ type: 'photo', media: { photo: i } })),
        disable_notification: true,
      },
    };
  return [album, message];
}
