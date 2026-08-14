type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Keep this deterministic traversal in lockstep with workflows/google_chat/sync.py. */
export function cardFallbackText(message: unknown): string {
  const parts: string[] = []
  const push = (value: unknown): void => {
    const valueText = text(value)
    if (valueText) parts.push(valueText)
  }
  const pushFields = (value: unknown, fields: string[]): void => {
    const item = record(value)
    if (item) fields.forEach(field => push(item[field]))
  }
  const collectIcon = (value: unknown): void => push(record(value)?.altText)
  const collectTextParagraph = (value: unknown): void => push(record(value)?.text)

  const collectOnClick = (value: unknown): void => {
    const menu = record(record(value)?.overflowMenu)
    if (!Array.isArray(menu?.items)) return
    for (const rawItem of menu.items) {
      const item = record(rawItem)
      if (!item) continue
      collectIcon(item.startIcon)
      push(item.text)
    }
  }

  const collectButton = (value: unknown): void => {
    const button = record(value)
    if (!button) return
    push(button.text)
    collectIcon(button.icon)
    push(button.altText)
    collectOnClick(button.onClick)
  }

  const collectButtons = (value: unknown): void => {
    const list = record(value)
    if (!Array.isArray(list?.buttons)) return
    list.buttons.forEach(collectButton)
  }

  const collectImage = (value: unknown): void => {
    const image = record(value)
    if (!image) return
    push(image.altText)
    collectOnClick(image.onClick)
  }

  const collectWidgets = (value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const rawWidget of value) {
      const widget = record(rawWidget)
      if (!widget) continue

      collectTextParagraph(widget.textParagraph)
      collectImage(widget.image)

      const decorated = record(widget.decoratedText)
      if (decorated) {
        collectIcon(decorated.icon)
        collectIcon(decorated.startIcon)
        push(decorated.topLabel)
        collectTextParagraph(decorated.topLabelText)
        push(decorated.text)
        collectTextParagraph(decorated.contentText)
        push(decorated.bottomLabel)
        collectTextParagraph(decorated.bottomLabelText)
        collectButton(decorated.button)
        collectIcon(decorated.endIcon)
        collectOnClick(decorated.onClick)
      }

      collectButtons(widget.buttonList)

      const input = record(widget.textInput)
      if (input) {
        pushFields(input, ['label', 'value', 'hintText', 'placeholderText'])
        const suggestions = record(input.initialSuggestions)
        if (Array.isArray(suggestions?.items)) {
          suggestions.items.forEach(item => push(record(item)?.text))
        }
      }

      const selection = record(widget.selectionInput)
      if (selection) {
        pushFields(selection, ['label', 'hintText'])
        if (Array.isArray(selection.items)) {
          selection.items.forEach(item => pushFields(item, ['text', 'bottomText']))
        }
      }

      pushFields(widget.dateTimePicker, ['label', 'valueMsEpoch'])

      const grid = record(widget.grid)
      if (grid) {
        push(grid.title)
        if (Array.isArray(grid.items)) {
          for (const rawItem of grid.items) {
            const item = record(rawItem)
            if (!item) continue
            pushFields(item, ['title', 'subtitle'])
            collectIcon(item.image)
          }
        }
        collectOnClick(grid.onClick)
      }

      const columns = record(widget.columns)
      if (Array.isArray(columns?.columnItems)) {
        columns.columnItems.forEach(item => collectWidgets(record(item)?.widgets))
      }

      const carousel = record(widget.carousel)
      if (Array.isArray(carousel?.carouselCards)) {
        for (const rawCard of carousel.carouselCards) {
          const card = record(rawCard)
          collectWidgets(card?.widgets)
          collectWidgets(card?.footerWidgets)
        }
      }

      const chipList = record(widget.chipList)
      if (Array.isArray(chipList?.chips)) {
        for (const rawChip of chipList.chips) {
          const chip = record(rawChip)
          if (!chip) continue
          push(chip.label)
          collectIcon(chip.icon)
          push(chip.altText)
          collectOnClick(chip.onClick)
        }
      }
    }
  }

  const collectHeader = (value: unknown): void => {
    const header = record(value)
    if (!header) return
    const title = text(header.title)
    const subtitle = text(header.subtitle)
    if (title || subtitle) parts.push([title, subtitle].filter(Boolean).join(' — '))
    push(header.imageAltText)
  }

  const collectCard = (value: unknown): void => {
    const card = record(value)
    if (!card) return
    collectHeader(card.header)
    collectHeader(card.peekCardHeader)
    if (Array.isArray(card.cardActions)) {
      card.cardActions.forEach(action => push(record(action)?.actionLabel))
    }
    if (Array.isArray(card.sections)) {
      for (const rawSection of card.sections) {
        const section = record(rawSection)
        if (!section) continue
        push(section.header)
        const collapse = record(section.collapseControl)
        collectButton(collapse?.expandButton)
        collectButton(collapse?.collapseButton)
        collectWidgets(section.widgets)
      }
    }
    const footer = record(card.fixedFooter)
    collectButton(footer?.primaryButton)
    collectButton(footer?.secondaryButton)
  }

  const collectLegacyButton = (value: unknown): void => {
    const button = record(value)
    if (!button) return
    push(record(button.textButton)?.text)
    push(record(button.imageButton)?.name)
  }

  const collectLegacyCard = (value: unknown): void => {
    const card = record(value)
    if (!card) return
    collectHeader(card.header)
    if (Array.isArray(card.cardActions)) {
      card.cardActions.forEach(action => push(record(action)?.actionLabel))
    }
    if (!Array.isArray(card.sections)) return
    for (const rawSection of card.sections) {
      const section = record(rawSection)
      if (!section) continue
      push(section.header)
      if (!Array.isArray(section.widgets)) continue
      for (const rawWidget of section.widgets) {
        const widget = record(rawWidget)
        if (!widget) continue
        collectTextParagraph(widget.textParagraph)
        const keyValue = record(widget.keyValue)
        if (keyValue) {
          pushFields(keyValue, ['topLabel', 'content', 'bottomLabel'])
          collectLegacyButton(keyValue.button)
        }
        if (Array.isArray(widget.buttons)) widget.buttons.forEach(collectLegacyButton)
      }
    }
  }

  const root = record(message)
  if (!root) return ''
  if (Array.isArray(root.cardsV2)) {
    root.cardsV2.forEach(entry => collectCard(record(entry)?.card))
  }
  if (Array.isArray(root.cards)) root.cards.forEach(collectLegacyCard)
  return parts.join('\n')
}
