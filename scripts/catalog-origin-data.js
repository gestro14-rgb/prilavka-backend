// Происхождение товаров: сопоставление списка владельца с реальными
// product_id, плюс чистка названий от географии.
//
// Источник истины — список, присланный владельцем магазина. Ничего не
// доискивается и не подменяется: нет товара в списке — нет у него origin.
//
// Формат записи:
//   origin     — что писать в products.origin
//   title      — новое название, если из старого убирается география
//   confidence — HIGH: товар и позиция списка совпадают однозначно;
//                MEDIUM: сопоставление по остатку, когда похожих товаров
//                несколько. LOW автоматически не пишем — таких тут нет.
//   note       — что именно потребовало решения
export const ORIGINS = {
  // ── Фрукты ────────────────────────────────────────────────────────────
  'Авакадо': { origin: 'Перу', confidence: 'HIGH' },
  yuar: { origin: 'ЮАР', title: 'Апельсины', confidence: 'HIGH', note: 'ЮАР из названия переехало в происхождение' },
  1346: { origin: 'Астрахань', title: 'Арбуз', confidence: 'HIGH', note: 'владелец заменил Дагестан на Астрахань' },
  // Кишмишей в базе три, а в списке две строки. Две позиции сами несут
  // «Азербайджан» в названии — они его и берут. Третьей, безымянной,
  // достаётся оставшийся Узбекистан.
  jiks: { origin: 'Азербайджан', title: 'Виноград, киш-миш', confidence: 'HIGH', note: 'Азербайджан стоял в названии' },
  'kish-pig': { origin: 'Азербайджан', title: 'Виноград, киш-миш', confidence: 'HIGH', note: 'Азербайджан стоял в названии' },
  'kish-mish': { origin: 'Узбекистан', confidence: 'MEDIUM', note: 'единственный кишмиш без страны в названии — ему достаётся оставшийся Узбекистан' },
  muss: { origin: 'Крым', title: 'Виноград, сорт Мускат', confidence: 'HIGH', note: 'Крым из названия переехал в происхождение' },
  grusha: { origin: 'ЮАР', confidence: 'HIGH' },
  'Лимон1': { origin: 'Узбекистан', title: 'Лимоны', confidence: 'HIGH', note: 'узбекские — это происхождение, а не сорт' },
  'Лимон2': { origin: 'ЮАР', title: 'Лимоны', confidence: 'HIGH', note: 'ЮАР из названия переехало в происхождение' },
  malin: { origin: 'Крым', title: 'Малина', confidence: 'HIGH' },
  manog: { origin: 'Перу', confidence: 'HIGH', note: 'спелый — не география, остаётся в названии' },
  manda: { origin: 'ЮАР', title: 'Мандарины', confidence: 'HIGH' },
  markuya: { origin: 'ЮАР', title: 'Маракуйя', confidence: 'HIGH' },
  // Бахчисарай владелец сохранил в своей же формулировке позиции
  // («Персики Бахчисарай»), поэтому из названия уходит только
  // дублирующий происхождение «Крым».
  Persic: { origin: 'Крым', title: 'Персики, Бахчисарай', confidence: 'HIGH', note: 'Бахчисарай владелец сохранил в названии, убран дублирующий Крым' },
  sliva: { origin: 'Крым', title: 'Слива спелая', confidence: 'HIGH' },
  'Яблоки1': { origin: 'Перу', confidence: 'HIGH', note: 'Леди-пинк — сорт, не трогаем' },
  'Яблоки': { origin: 'Тула', confidence: 'HIGH', note: 'Медовый хруст — сорт, не трогаем' },

  // ── Зелень ────────────────────────────────────────────────────────────
  'bazilik-1782676306107': { origin: 'Краснодар', confidence: 'HIGH' },
  'basil-purple': { origin: 'Краснодар', confidence: 'HIGH' },
  cilantro: { origin: 'Рязань', confidence: 'HIGH' },
  'green-onion': { origin: 'Рязань', confidence: 'HIGH' },
  5678: { origin: 'Тамбов', confidence: 'HIGH' },
  chard: { origin: 'Тамбов', confidence: 'HIGH' },
  mint: { origin: 'Краснодар', confidence: 'HIGH' },
  parsley: { origin: 'Рязань', confidence: 'HIGH' },
  rozmarin: { origin: 'Краснодар', confidence: 'HIGH' },
  5788: { origin: 'Краснодар', confidence: 'HIGH' },
  'salat-aysberg-1782676064050': { origin: 'Московская область', confidence: 'HIGH' },
  'salat-listovoy-1782676064095': { origin: 'Краснодар', confidence: 'HIGH', note: 'Латук = салат латук из списка' },
  'salat-romano-1782676064105': { origin: 'Крым', confidence: 'HIGH' },
  'selderey-1782676306125': { origin: 'Подмосковье', confidence: 'HIGH' },
  timyan: { origin: 'Краснодар', confidence: 'HIGH' },
  dill: { origin: 'Рязань', confidence: 'HIGH' },
  'spinach-leaf': { origin: 'Рязань', confidence: 'HIGH' },
  sorrel: { origin: 'Рязань', confidence: 'HIGH' },

  // ── Овощи ─────────────────────────────────────────────────────────────
  'baklazhan-sort-matrosiki-1782676064229': { origin: 'Воронеж', confidence: 'HIGH' },
  'baklazhany-nezhnye-1782676064116': { origin: 'Ростов', title: 'Баклажаны, фермерские', confidence: 'HIGH' },
  'belyy-luk-1782676063951': { origin: 'Крым', confidence: 'HIGH' },
  btoh: { origin: 'Воронеж', title: 'Брокколи', confidence: 'HIGH' },
  3939: { origin: 'Московская область', confidence: 'HIGH', note: 'владелец поправил Краснодар на Московскую область' },
  shamp: { origin: 'Рязань', confidence: 'HIGH' },
  'kabachki-1782676064127': { origin: 'Рязань', title: 'Кабачки, грунтовые', confidence: 'HIGH' },
  'kapusta-1782676306137': { origin: 'Воронеж', confidence: 'HIGH' },
  'kapusta-krasnaya-1782676064184': { origin: 'Воронеж', confidence: 'HIGH' },
  'kartofel-zhukovskiy-1782660009856': { origin: 'Тамбов', confidence: 'HIGH', note: 'Жуковский — сорт, не трогаем' },
  beybi: { origin: 'Краснодар', confidence: 'HIGH', note: 'Бейби = Baby из списка' },
  potato: { origin: 'Тамбов', confidence: 'HIGH' },
  korn: { origin: 'Краснодар', confidence: 'HIGH', note: 'Бандюэль = Bonduelle, бренд, не трогаем' },
  'luk-repchatyy-1782676064362': { origin: 'Тамбов', confidence: 'HIGH' },
  'luk-yaltinskiy-1782676063988': { origin: 'Крым', confidence: 'HIGH', note: 'ялтинский — сорт лука, в названии остаётся' },
  'chesnok-1782676064241': { origin: 'Киргизия', confidence: 'HIGH' },
  'morkov-1782676064392': { origin: 'Краснодар', confidence: 'HIGH' },
  'ogurtsy-lukhovitskie-1782676306082': { origin: 'Луховицы', confidence: 'HIGH', note: 'луховицкие — устоявшееся название типа огурцов, владелец сохранил его и в своём списке' },
  'ogurtsy-ryazan-1782676064319': { origin: 'Рязань', title: 'Огурцы', confidence: 'HIGH' },
  'pekinskaya-kapusta-1782676064381': { origin: 'Воронеж', confidence: 'HIGH' },
  'perets-zelyonyy-salatnyy-1782676064138': { origin: 'Краснодар', title: 'Перец, Градиент', confidence: 'HIGH', note: 'Градиент — сорт, Краснодар переехал в происхождение' },
  'pepper-red': { origin: 'Воронеж', confidence: 'HIGH', note: 'Рамиро — сорт, не трогаем' },
  // В названии стоял «краснодар», в списке владельца — Ставропольский
  // край. Список главнее: он и есть источник истины для этой задачи.
  'perrc-beybi': { origin: 'Ставропольский край', title: 'Перец-мини', confidence: 'HIGH', note: 'в названии стоял краснодар — заменён на указанный владельцем Ставропольский край' },
  angel: { origin: 'Краснодар', confidence: 'HIGH' },
  'perets-ostryy-1782676064173': { origin: 'Краснодар', confidence: 'HIGH' },
  888: { origin: 'Краснодар', confidence: 'HIGH' },
  'pomidor-sort-paradayz-1782676064331': { origin: 'Краснодар', title: 'Помидор Парадайз', confidence: 'HIGH', note: 'Парадайз = Paradise, сорт' },
  'pomidor-sort-madrid-1782676064195': { origin: 'Волгоград', confidence: 'HIGH' },
  'pomidory-makhitos-1782658981883': { origin: 'Ростовская область', confidence: 'HIGH', note: 'владелец разрешил общее обозначение вместо станицы Кривянской' },
  'redis-1782676064276': { origin: 'Воронеж', confidence: 'HIGH' },
  'svyokla-1782676064371': { origin: 'Тамбов', title: 'Свёкла', confidence: 'HIGH' },
  'tomato-cherry': { origin: 'Воронеж', confidence: 'HIGH' },
  1245: { origin: 'Краснодар', confidence: 'HIGH' },
  'fasol-ploskaya-1782676064352': { origin: 'Краснодар', confidence: 'HIGH' },
  'fasol-struchkovaya-1782676305948': { origin: 'Краснодар', confidence: 'HIGH' },
  'tsvetnaya-kapusta-1782676063807': { origin: 'Краснодар', confidence: 'HIGH' },
  'tsukini-1782676064252': { origin: 'Краснодар', confidence: 'HIGH', note: 'Цукини = Цуккини из списка' },
};

// Товары, которым происхождение осознанно не ставится.
export const SKIPPED = {
  agrusha: 'владелец указал: пока не заполнять',
  yabloko: 'владелец указал: пока не заполнять',
  'vishnya-1782676306045': 'в списке владельца вишни нет',
  'chereshnya-1782676306030': 'в списке владельца черешни нет',
  'Голубика': 'в списке владельца голубики нет; Белорусь из названия не переношу — список владельца для этой задачи главнее',
  'Клубника': 'в списке владельца клубники нет; Липецк из названия не переношу по той же причине',
  peach: 'в списке есть только Персики Бахчисарай; плоские персики — отдельный товар, их происхождение не указано',
  356: 'в списке есть баклажаны фермерские и Матросики; сорта Буржуй нет',
  fennel: 'в списке владельца фенхеля нет',
};
