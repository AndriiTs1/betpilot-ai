// Centralized, typed translation dictionary for the Mini App UI. Every
// player-facing UI string translated in this stage lives here — never
// scattered as `locale === "ru" ? "..." : "..."` inline in a component.
//
// This is presentation-only. Nothing here is ever imported by
// lib/ai/betParser.ts, lib/bets/*, or lib/odds/* — UI locale has no
// relationship to bet-input language, AI parsing, odds matching, or
// provider/team-name normalization (see lib/i18n/locale.ts's own header).
//
// Team/league/provider names, user-entered bet text, and every stored
// enum/status value at the API/DB layer are never translated — only the
// static chrome around them.

import type { Locale } from "./locale";

// One explicit interface (not `typeof en` + `as const`) so both `en` and
// `ru` are plain `string`-typed — if `en` used `as const`, `ru`'s own
// (necessarily different) string content would fail to satisfy the
// resulting literal-typed shape. Typing both dictionaries against this one
// interface is what makes a missing/misspelled key in EITHER dictionary a
// compile-time error (`tsc --noEmit`), rather than a silent runtime gap —
// this is the "type safety if feasible" the localization foundation calls
// for.
export interface TranslationDict {
  common: {
    // aria-label for the language control itself.
    language: string;
    russian: string;
    english: string;
  };
  banner: {
    headlineLine1: string;
    headlineLine2: string;
    feature1: string;
    feature2: string;
    feature3: string;
    loading: string;
  };
  home: {
    loading: string;
    failedToLoad: string;
    retry: string;
    aiOnline: string;
    online: string;
    welcome: string;
    ready: string;
    sendBet: string;
    screenshotOrText: string;
    aiWillCheck: string;
    sendBetAriaLabel: string;
    available: string;
    exposure: string;
    pending: string;
    lastActivity: string;
    noActivityYet: string;
    activityPending: string;
    activityAccepted: string;
    activityRejected: string;
    activityWon: string;
    activityLost: string;
    activityVoid: string;
    activityHalfWon: string;
    activityHalfLost: string;
    aiChecksNote: string;
    // Localization completion pass — Stage 5G.3-equivalent: the player
    // "not registered" screen was still hardcoded Russian even in English
    // UI. See app/miniapp/page.tsx's DataScreen.
    notRegistered: string;
  };
  nav: {
    newBet: string;
    active: string;
    history: string;
    balance: string;
  };
  sheet: {
    title: string;
    sendScreenshot: string;
    sendText: string;
    cancel: string;
    ariaLabel: string;
  };
  bet: {
    placeBet: string;
    single: string;
    express: string;
    placeholder: string;
    preview: string;
    typeAriaLabel: string;
    // Localization completion pass — the remaining BetTextForm chrome that
    // was still hardcoded English (mixed into the RU flow) or, in the
    // "not registered" case above, hardcoded Russian (mixed into the EN
    // flow). See components/miniapp/BetTextForm.tsx.
    back: string;
    messageAriaLabel: string;
    checking: string;
    tryAgain: string;
    timeoutTitle: string;
    timeoutBody: string;
    editMessage: string;
    // Structured SINGLE input (Event / Selection / Stake) — composed into
    // one free-text string before it ever reaches fetchBetPreview, so the
    // AI parser/preview endpoint contract is completely unchanged; only
    // where the text comes from changed. EXPRESS keeps using `placeholder`/
    // `messageAriaLabel`/`preview` above, untouched.
    eventLabel: string;
    eventPlaceholder: string;
    selectionLabel: string;
    selectionPlaceholder: string;
    stakeLabel: string;
    reviewBet: string;
    // Structured EXPRESS input (a variable-length list of legs sharing one
    // Stake) — see components/miniapp/BetTextForm.tsx. eventLabel/
    // selectionLabel above are reused as each leg's Event/Selection
    // aria-labels; stakeLabel above is reused as-is for the one shared
    // Stake field.
    expressLegTitle: string;
    expressEventPlaceholder: string;
    expressSelectionPlaceholder: string;
    addEvent: string;
    removeEvent: string;
    reviewExpress: string;
  };
  active: {
    title: string;
    emptyState: string;
    confirmedBadge: string;
    selectionsCount: string;
  };
  history: {
    title: string;
    emptyState: string;
    selectionsCount: string;
  };
  balance: {
    available: string;
    limit: string;
    exposure: string;
    pending: string;
  };
  // Localization completion pass — getConfirmButtonLabel
  // (canConfirmBetSlip.ts), shared by BetTextForm.tsx and
  // BetScreenshotForm.tsx.
  confirm: {
    confirming: string;
    oddsUnavailable: string;
    confirmBet: string;
  };
  // Localization completion pass — every player-facing failure message
  // across betPreviewApi.ts (getBetPreviewErrorMessage),
  // betConfirmApi.ts (getBetConfirmErrorMessage), betScreenshotApi.ts
  // (getBetScreenshotErrorMessage), and telegramAuthError.ts
  // (getTelegramAuthErrorMessage). These are presentation strings for
  // already-computed server/client failure CODES — the codes themselves,
  // the classification logic, and every business rule that produces them
  // are completely untouched; only the rendered text is localized.
  error: {
    network: string;
    timeout: string;
    generic: string;
    telegramExpired: string;
    telegramInvalid: string;
    telegramUnavailable: string;
    playerNotFound: string;
    playerNotFoundConfirm: string;
    invalidMessage: string;
    parseFailed: string;
    aiTimeoutPreview: string;
    invalidBetSlip: string;
    eventNotFound: string;
    ambiguousEvent: string;
    unsupportedSelection: string;
    eventAlreadyStarted: string;
    oddsUnavailable: string;
    rateLimited: string;
    rateLimitedWithSeconds: string;
    allLegsExcluded: string;
    previewExpired: string;
    oddsChanged: string;
    missingFile: string;
    emptyFile: string;
    fileTooLarge: string;
    unsupportedFileType: string;
    invalidImageSignature: string;
    imageTooLarge: string;
    aiTimeoutScreenshot: string;
    aiUnavailable: string;
    ocrNoText: string;
    numericMismatch: string;
    marketMismatch: string;
    imageNotRecognized: string;
    incompleteBetData: string;
    marketIntentUnreconciled: string;
  };
  // Localization completion pass — BetPreviewCard.tsx (the SINGLE/EXPRESS
  // preview shown before Confirm, in both the text and screenshot flows).
  preview: {
    sport: string;
    event: string;
    competition: string;
    date: string;
    selection: string;
    stake: string;
    odds: string;
    potentialWin: string;
    totalOdds: string;
    notAvailable: string;
    notProvided: string;
    removing: string;
    removeAndRecalculate: string;
    oddsUnverifiedTitle: string;
    oddsUnverifiedMessage: string;
    oddsUnavailableNotice: string;
    providerUnavailableTitle: string;
    providerUnavailableMessage: string;
    expressCount: string;
  };
  // Localization completion pass — BetTicket.tsx (the post-confirmation
  // ticket screen). STATUS_CONFIG itself (BetTicket.tsx) stays canonical
  // English — it's the existing, tested identity/icon/color source; these
  // keys drive only the actually-rendered label/detail text.
  ticket: {
    submittedLabel: string;
    submittedDetail: string;
    confirmedLabel: string;
    confirmedDetail: string;
    rejectedLabel: string;
    rejectedDetail: string;
    wonLabel: string;
    wonDetail: string;
    lostLabel: string;
    lostDetail: string;
    voidLabel: string;
    voidDetail: string;
    leg: string;
    combinedOdds: string;
    availableCredit: string;
    verifiedByBetPilot: string;
    done: string;
    viewHistory: string;
    digitalTicketAriaLabel: string;
  };
  // Localization completion pass — BetScreenshotForm.tsx (the screenshot
  // bet flow) UI chrome, distinct from its own error messages (see
  // `error` above).
  screenshot: {
    galleryAriaLabel: string;
    cameraAriaLabel: string;
    chooseFromGalleryLabel: string;
    takePhotoLabel: string;
    uploadTitle: string;
    uploadSubtitle: string;
    recognizeBet: string;
    recognizing: string;
    remove: string;
    removeImageAriaLabel: string;
    chooseDifferentImage: string;
    selectedImageAlt: string;
  };
  // Localization completion pass — lib/bets/oddsStatusBadge.ts's
  // ODDS_STATUS_BADGES, consumed by components/bets/SelectionRow.tsx
  // (via BetPreviewCard.tsx's EXPRESS branch) and BetTicket.tsx's
  // OddsStatusPill. Canonical OddsVerificationStatus values themselves
  // (VERIFIED/ODDS_CHANGED/NOT_FOUND/UNAVAILABLE/PENDING) are untouched —
  // only their display label.
  oddsStatus: {
    verified: string;
    oddsChanged: string;
    notFound: string;
    unavailable: string;
    pending: string;
  };
}

const en: TranslationDict = {
  common: {
    language: "Language",
    russian: "Русский",
    english: "English",
  },
  banner: {
    headlineLine1: "Your AI assistant",
    headlineLine2: "for sports betting",
    feature1: "Send a slip or text",
    feature2: "Odds verification",
    feature3: "Fast confirmation",
    loading: "Loading...",
  },
  home: {
    loading: "Loading...",
    failedToLoad: "Failed to load data.",
    retry: "Retry",
    aiOnline: "AI Online",
    online: "Online",
    welcome: "Welcome, {name}",
    ready: "Ready to check your bet",
    sendBet: "Place a bet",
    screenshotOrText: "Screenshot or text",
    aiWillCheck: "AI will check the events, odds and stake",
    sendBetAriaLabel: "Place a bet — screenshot or text",
    available: "Available",
    exposure: "In play",
    pending: "Pending",
    lastActivity: "Recent activity",
    noActivityYet: "Your recent bets will show up here",
    activityPending: "Pending",
    activityAccepted: "Accepted",
    activityRejected: "Rejected",
    activityWon: "Won",
    activityLost: "Lost",
    activityVoid: "Void",
    activityHalfWon: "Half won",
    activityHalfLost: "Half lost",
    aiChecksNote: "AI checks the odds before confirming",
    notRegistered: "You are not yet registered. Please contact your operator.",
  },
  nav: {
    newBet: "New bet",
    active: "Active",
    history: "History",
    balance: "Balance",
  },
  sheet: {
    title: "How do you want to place a bet?",
    sendScreenshot: "Send a screenshot",
    sendText: "Write a bet",
    cancel: "Cancel",
    ariaLabel: "Bet submission method",
  },
  bet: {
    placeBet: "Place a bet",
    single: "Single",
    express: "Express",
    placeholder: "Team, outcome, stake",
    preview: "Preview bet",
    typeAriaLabel: "Bet type",
    back: "Back",
    messageAriaLabel: "Bet message",
    checking: "Checking bet...",
    tryAgain: "Try again",
    timeoutTitle: "AI service timed out",
    timeoutBody: "Your bet was not rejected. The analysis took too long. Please try again.",
    editMessage: "Edit message",
    eventLabel: "Event",
    eventPlaceholder: "Example: Inter — Juventus",
    selectionLabel: "Selection",
    selectionPlaceholder: "Example: Inter to win",
    stakeLabel: "Stake",
    reviewBet: "Review bet",
    expressLegTitle: "Event {number}",
    expressEventPlaceholder: "Example: Arsenal — Chelsea",
    expressSelectionPlaceholder: "Example: Arsenal to win",
    addEvent: "+ Add event",
    removeEvent: "Remove event {number}",
    reviewExpress: "Review express",
  },
  active: {
    title: "Active",
    emptyState: "Bets that haven't settled yet will appear here.",
    confirmedBadge: "Confirmed",
    selectionsCount: "{count} selections",
  },
  history: {
    title: "History",
    emptyState: "Finished bets will appear here.",
    selectionsCount: "{count} selections",
  },
  balance: {
    available: "Available",
    limit: "Limit",
    exposure: "In play",
    pending: "Pending",
  },
  confirm: {
    confirming: "Confirming...",
    oddsUnavailable: "Odds unavailable",
    confirmBet: "Confirm bet",
  },
  error: {
    network: "Unable to connect. Check your internet connection.",
    timeout: "The request took too long. Please try again.",
    generic: "Something went wrong. Please try again.",
    telegramExpired: "Your Telegram session has expired. Close and reopen the Mini App through the bot.",
    telegramInvalid: "Unable to verify your Telegram session. Close and reopen the Mini App through the bot.",
    telegramUnavailable: "Telegram WebApp is unavailable.",
    playerNotFound: "Your player account was not found.",
    playerNotFoundConfirm: "Your player account could not be found.",
    invalidMessage: "Enter a valid bet message.",
    parseFailed: "We could not understand this bet. Try including the event, selection, and stake.",
    aiTimeoutPreview: "Your bet was not rejected. The analysis took too long. Please try again.",
    invalidBetSlip: "This bet doesn't have a valid number of selections. Please try again.",
    eventNotFound: "We couldn't find that team or match. Please check the spelling and try again.",
    ambiguousEvent: "We found more than one matching event. Please be more specific, e.g. include both team names.",
    unsupportedSelection: "Only Home win, Draw, or Away win are supported for this event right now.",
    eventAlreadyStarted: "This match has already started. Please choose a different event.",
    oddsUnavailable: "Odds for this selection aren't available right now. Please try again shortly.",
    rateLimited: "Too many attempts. Please try again shortly.",
    rateLimitedWithSeconds: "Too many attempts. Please try again in {seconds} seconds.",
    allLegsExcluded: "Removing this leg would leave nothing to bet on. Please cancel and start over.",
    previewExpired: "⏳ This preview has expired.\n\nOdds may have changed.\n\nPlease generate a new preview.",
    oddsChanged: "Odds have changed. Please review and confirm again.",
    missingFile: "Please choose an image first.",
    emptyFile: "That file is empty. Please choose a different image.",
    fileTooLarge: "That image is too large (max 10 MB). Please choose a smaller file.",
    unsupportedFileType: "Unsupported file type. Please use a JPEG, PNG, or WEBP image.",
    invalidImageSignature: "That file doesn't look like a valid image. Please choose a different file.",
    imageTooLarge: "That image's resolution is too large. Please crop it to the bet slip and try again.",
    aiTimeoutScreenshot: "Recognition took too long. Please try again.",
    aiUnavailable: "Bet recognition is temporarily unavailable. Please try again later.",
    ocrNoText: "We couldn't read enough text from this image. Try a clearer screenshot.",
    numericMismatch:
      "We spotted more than one possible stake or odds value on this screenshot. Please make sure only your actual bet is visible, or enter it manually.",
    marketMismatch:
      "We couldn't confidently match the selection on this screenshot. Please try a clearer screenshot or enter the bet manually.",
    imageNotRecognized: "We couldn't recognize a bet slip in this image. Please try a clearer screenshot.",
    incompleteBetData: "We could only partially read this bet slip. Please try a clearer screenshot.",
    marketIntentUnreconciled:
      "We couldn't confirm which team or match your selection refers to. Please try again or enter the bet manually.",
  },
  preview: {
    sport: "Sport",
    event: "Event",
    competition: "Competition",
    date: "Date",
    selection: "Selection",
    stake: "Stake",
    odds: "Odds",
    potentialWin: "Potential win",
    totalOdds: "Total odds",
    notAvailable: "Not available",
    notProvided: "Not provided",
    removing: "Removing…",
    removeAndRecalculate: "Remove and recalculate",
    oddsUnverifiedTitle: "Odds could not be verified",
    oddsUnverifiedMessage:
      "We couldn't verify this event or market with the odds provider. Please check the bet details or try again later.",
    oddsUnavailableNotice: "Odds for this selection are currently unavailable.",
    providerUnavailableTitle: "Live odds are temporarily unavailable",
    providerUnavailableMessage: "We couldn't verify this bet right now. Please try again later.",
    expressCount: "Express ×{count}",
  },
  ticket: {
    submittedLabel: "Submitted",
    submittedDetail: "Awaiting confirmation",
    confirmedLabel: "Confirmed",
    confirmedDetail: "Now active",
    rejectedLabel: "Rejected",
    rejectedDetail: "Not accepted",
    wonLabel: "Won",
    wonDetail: "Settled",
    lostLabel: "Lost",
    lostDetail: "Settled",
    voidLabel: "Void",
    voidDetail: "Voided",
    leg: "Leg {n}",
    combinedOdds: "Combined odds",
    availableCredit: "Available credit",
    verifiedByBetPilot: "Verified by BetPilot AI",
    done: "Done",
    viewHistory: "View History",
    digitalTicketAriaLabel: "Digital bet ticket, status: {status}",
  },
  screenshot: {
    galleryAriaLabel: "Choose image from gallery",
    cameraAriaLabel: "Take a photo",
    chooseFromGalleryLabel: "Choose from gallery",
    takePhotoLabel: "Take photo",
    uploadTitle: "Upload your bet slip",
    uploadSubtitle: "Choose a photo from your gallery or take a new one.",
    recognizeBet: "Recognize bet",
    recognizing: "Recognizing...",
    remove: "Remove",
    removeImageAriaLabel: "Remove image",
    chooseDifferentImage: "Choose different image",
    selectedImageAlt: "Selected bet slip screenshot",
  },
  oddsStatus: {
    verified: "Verified",
    oddsChanged: "Odds changed",
    notFound: "Not found",
    unavailable: "Unavailable",
    pending: "Pending",
  },
};

const ru: TranslationDict = {
  common: {
    language: "Язык",
    russian: "Русский",
    english: "English",
  },
  banner: {
    headlineLine1: "Ваш AI-ассистент",
    headlineLine2: "для ставок на спорт",
    feature1: "Отправьте купон или текст",
    feature2: "Проверка коэффициентов",
    feature3: "Быстрое подтверждение",
    loading: "Загрузка...",
  },
  home: {
    loading: "Загрузка...",
    failedToLoad: "Не удалось загрузить данные.",
    retry: "Повторить",
    aiOnline: "AI Online",
    online: "Онлайн",
    welcome: "Добро пожаловать, {name}",
    ready: "Готов проверить вашу ставку",
    sendBet: "Отправить ставку",
    screenshotOrText: "Скриншот или текст",
    aiWillCheck: "AI проверит события, коэффициенты и сумму",
    sendBetAriaLabel: "Отправить ставку — скриншот или текст",
    available: "Доступно",
    exposure: "В игре",
    pending: "Ожидает",
    lastActivity: "Последняя активность",
    noActivityYet: "Здесь появятся ваши последние ставки",
    activityPending: "Ожидает",
    activityAccepted: "Принята",
    activityRejected: "Отклонена",
    activityWon: "Выиграла",
    activityLost: "Проиграла",
    activityVoid: "Возврат",
    activityHalfWon: "Частичный выигрыш",
    activityHalfLost: "Частичный проигрыш",
    aiChecksNote: "AI проверяет коэффициенты перед подтверждением",
    notRegistered: "Вы ещё не зарегистрированы. Обратитесь к оператору.",
  },
  nav: {
    newBet: "Новая ставка",
    active: "Активные",
    history: "История",
    balance: "Баланс",
  },
  sheet: {
    title: "Как отправить ставку?",
    sendScreenshot: "Отправить скриншот",
    sendText: "Написать ставку",
    cancel: "Отмена",
    ariaLabel: "Способ отправки ставки",
  },
  bet: {
    placeBet: "Разместить ставку",
    single: "Ординар",
    express: "Экспресс",
    placeholder: "Команда, исход, ставка",
    preview: "Предпросмотр ставки",
    typeAriaLabel: "Тип ставки",
    back: "Назад",
    messageAriaLabel: "Сообщение со ставкой",
    checking: "Проверка ставки...",
    tryAgain: "Повторить",
    timeoutTitle: "AI сервис не ответил вовремя",
    timeoutBody: "Ваша ставка не отклонена. Анализ занял слишком много времени. Попробуйте снова.",
    editMessage: "Изменить сообщение",
    eventLabel: "Событие",
    eventPlaceholder: "Например: Интер — Ювентус",
    selectionLabel: "Исход",
    selectionPlaceholder: "Например: Интер победит",
    stakeLabel: "Ставка",
    reviewBet: "Проверить ставку",
    expressLegTitle: "Событие {number}",
    expressEventPlaceholder: "Например: Арсенал — Челси",
    expressSelectionPlaceholder: "Например: Арсенал победит",
    addEvent: "+ Добавить событие",
    removeEvent: "Удалить событие {number}",
    reviewExpress: "Проверить экспресс",
  },
  active: {
    title: "Активные",
    emptyState: "Здесь будут отображаться ставки, которые ещё не рассчитаны.",
    confirmedBadge: "Подтверждено",
    selectionsCount: "{count} события",
  },
  history: {
    title: "История",
    emptyState: "Здесь будут отображаться завершённые ставки.",
    selectionsCount: "{count} события",
  },
  balance: {
    available: "Доступно",
    limit: "Лимит",
    exposure: "В игре",
    pending: "В ожидании",
  },
  confirm: {
    confirming: "Подтверждение...",
    oddsUnavailable: "Коэффициент недоступен",
    confirmBet: "Подтвердить ставку",
  },
  error: {
    network: "Не удалось подключиться. Проверьте интернет-соединение.",
    timeout: "Запрос выполнялся слишком долго. Попробуйте снова.",
    generic: "Что-то пошло не так. Попробуйте снова.",
    telegramExpired: "Сессия Telegram истекла. Закройте и снова откройте Mini App через бота.",
    telegramInvalid: "Не удалось подтвердить сессию Telegram. Закройте и снова откройте Mini App через бота.",
    telegramUnavailable: "Telegram WebApp недоступен.",
    playerNotFound: "Ваш игровой аккаунт не найден.",
    playerNotFoundConfirm: "Не удалось найти ваш игровой аккаунт.",
    invalidMessage: "Введите корректное сообщение со ставкой.",
    parseFailed: "Не удалось распознать ставку. Укажите событие, исход и сумму.",
    aiTimeoutPreview: "Ваша ставка не отклонена. Анализ занял слишком много времени. Попробуйте снова.",
    invalidBetSlip: "В ставке недопустимое количество событий. Попробуйте снова.",
    eventNotFound: "Не удалось найти эту команду или матч. Проверьте написание и попробуйте снова.",
    ambiguousEvent: "Найдено несколько подходящих событий. Уточните запрос, например укажите обе команды.",
    unsupportedSelection: "Для этого события пока поддерживаются только победа хозяев, ничья или победа гостей.",
    eventAlreadyStarted: "Матч уже начался. Выберите другое событие.",
    oddsUnavailable: "Коэффициент на этот исход сейчас недоступен. Попробуйте немного позже.",
    rateLimited: "Слишком много попыток. Попробуйте немного позже.",
    rateLimitedWithSeconds: "Слишком много попыток. Попробуйте снова через {seconds} с.",
    allLegsExcluded: "После удаления этого события ставка станет пустой. Отмените и начните заново.",
    previewExpired: "⏳ Срок действия предпросмотра истёк.\n\nКоэффициенты могли измениться.\n\nСоздайте новый предпросмотр.",
    oddsChanged: "Коэффициенты изменились. Проверьте и подтвердите ставку ещё раз.",
    missingFile: "Сначала выберите изображение.",
    emptyFile: "Файл пуст. Выберите другое изображение.",
    fileTooLarge: "Изображение слишком большое (макс. 10 МБ). Выберите файл меньшего размера.",
    unsupportedFileType: "Неподдерживаемый тип файла. Используйте JPEG, PNG или WEBP.",
    invalidImageSignature: "Этот файл не похож на изображение. Выберите другой файл.",
    imageTooLarge: "Разрешение изображения слишком большое. Обрежьте его до купона и попробуйте снова.",
    aiTimeoutScreenshot: "Распознавание заняло слишком много времени. Попробуйте снова.",
    aiUnavailable: "Распознавание ставок временно недоступно. Попробуйте позже.",
    ocrNoText: "Не удалось прочитать достаточно текста на изображении. Попробуйте сделать более чёткий скриншот.",
    numericMismatch:
      "На скриншоте найдено несколько возможных значений суммы или коэффициента. Убедитесь, что видна только ваша ставка, либо введите её вручную.",
    marketMismatch:
      "Не удалось точно сопоставить исход на скриншоте. Сделайте более чёткий скриншот или введите ставку вручную.",
    imageNotRecognized: "Не удалось распознать купон на этом изображении. Попробуйте сделать более чёткий скриншот.",
    incompleteBetData: "Купон удалось прочитать лишь частично. Попробуйте сделать более чёткий скриншот.",
    marketIntentUnreconciled:
      "Не удалось подтвердить, к какой команде или матчу относится ваш исход. Попробуйте снова или введите ставку вручную.",
  },
  preview: {
    sport: "Спорт",
    event: "Событие",
    competition: "Турнир",
    date: "Дата",
    selection: "Исход",
    stake: "Ставка",
    odds: "Коэффициент",
    potentialWin: "Возможный выигрыш",
    totalOdds: "Общий коэффициент",
    notAvailable: "Недоступно",
    notProvided: "Не указано",
    removing: "Удаление…",
    removeAndRecalculate: "Удалить и пересчитать",
    oddsUnverifiedTitle: "Коэффициенты не удалось проверить",
    oddsUnverifiedMessage:
      "Не удалось проверить это событие или рынок у поставщика коэффициентов. Проверьте детали ставки или попробуйте позже.",
    oddsUnavailableNotice: "Коэффициент на этот исход сейчас недоступен.",
    providerUnavailableTitle: "Актуальные коэффициенты временно недоступны",
    providerUnavailableMessage: "Не удалось проверить эту ставку прямо сейчас. Попробуйте позже.",
    expressCount: "Экспресс ×{count}",
  },
  ticket: {
    submittedLabel: "Отправлено",
    submittedDetail: "Ожидает подтверждения",
    confirmedLabel: "Подтверждено",
    confirmedDetail: "Активна",
    rejectedLabel: "Отклонено",
    rejectedDetail: "Не принято",
    wonLabel: "Выигрыш",
    wonDetail: "Рассчитано",
    lostLabel: "Проигрыш",
    lostDetail: "Рассчитано",
    voidLabel: "Аннулировано",
    voidDetail: "Аннулировано",
    leg: "Событие {n}",
    combinedOdds: "Общий коэффициент",
    availableCredit: "Доступный лимит",
    verifiedByBetPilot: "Проверено BetPilot AI",
    done: "Готово",
    viewHistory: "История ставок",
    digitalTicketAriaLabel: "Электронный билет ставки, статус: {status}",
  },
  screenshot: {
    galleryAriaLabel: "Выбрать изображение из галереи",
    cameraAriaLabel: "Сделать фото",
    chooseFromGalleryLabel: "Выбрать из галереи",
    takePhotoLabel: "Сделать фото",
    uploadTitle: "Загрузите купон со ставкой",
    uploadSubtitle: "Выберите фото из галереи или сделайте новое.",
    recognizeBet: "Распознать ставку",
    recognizing: "Распознавание...",
    remove: "Удалить",
    removeImageAriaLabel: "Удалить изображение",
    chooseDifferentImage: "Выбрать другое изображение",
    selectedImageAlt: "Выбранный скриншот купона",
  },
  oddsStatus: {
    verified: "Проверено",
    oddsChanged: "Коэффициент изменился",
    notFound: "Не найдено",
    unavailable: "Недоступно",
    pending: "Ожидание",
  },
};

export const translations: Record<Locale, TranslationDict> = { en, ru };

// Dot-path key, e.g. "home.welcome" — derived from the interface itself so
// a typo can never compile. Two levels only (matches every key in
// TranslationDict above); a deeper namespace would need a recursive
// template-literal type, not warranted for this dictionary's actual shape.
type NestedKeyOf<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${keyof T[K] & string}`;
}[keyof T & string];

export type TranslationKey = NestedKeyOf<TranslationDict>;

function readKey(dict: TranslationDict, key: TranslationKey): string {
  const [namespace, leaf] = key.split(".") as [keyof TranslationDict, string];
  const value = (dict[namespace] as Record<string, string>)[leaf];
  return value;
}

// Minimal `{token}` interpolation — the only dynamic string in this
// dictionary today is home.welcome's "{name}". Unknown tokens are left
// untouched rather than throwing, so a future translation typo degrades to
// visible-but-harmless output instead of a runtime crash.
export function translate(locale: Locale, key: TranslationKey, params?: Record<string, string>): string {
  const raw = readKey(translations[locale], key);
  if (!params) return raw;

  return raw.replace(/\{(\w+)\}/g, (match, token: string) => params[token] ?? match);
}
