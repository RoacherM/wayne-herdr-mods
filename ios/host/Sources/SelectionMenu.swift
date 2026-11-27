import UIKit

/// The terminal's text-selection menu, in the system's own style (UIEditMenuInteraction).
/// The selection itself (highlight, drag handles) is drawn by the terminal page: a terminal is a
/// grid of painted cells, not a text view, so UIKit cannot select it. Only the menu is native.
/// Actions go back to the nsh app (`selection.action`), which forwards them to the page.
@MainActor
final class SelectionMenu: NSObject, @preconcurrency UIEditMenuInteractionDelegate {
  /// `copy` / `all` / `open`.
  var onAction: (String) -> Void = { _ in }

  private var interaction: UIEditMenuInteraction?
  private var targetRect: CGRect = .zero
  private var hasUrl = false

  func show(in view: UIView, rect: CGRect, url: Bool) {
    targetRect = rect
    hasUrl = url
    if interaction == nil {
      let it = UIEditMenuInteraction(delegate: self)
      view.addInteraction(it)
      interaction = it
    }
    let point = CGPoint(x: rect.midX, y: rect.minY)
    interaction?.presentEditMenu(with: UIEditMenuConfiguration(identifier: "term-selection", sourcePoint: point))
  }

  func hide() {
    interaction?.dismissMenu()
  }

  func editMenuInteraction(_ interaction: UIEditMenuInteraction, targetRectFor configuration: UIEditMenuConfiguration) -> CGRect {
    targetRect
  }

  func editMenuInteraction(_ interaction: UIEditMenuInteraction, menuFor configuration: UIEditMenuConfiguration, suggestedActions: [UIMenuElement]) -> UIMenu? {
    var actions: [UIMenuElement] = [
      UIAction(title: "复制", image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in self?.onAction("copy") },
      UIAction(title: "全选", image: UIImage(systemName: "checkmark.rectangle.stack")) { [weak self] _ in self?.onAction("all") },
    ]
    if hasUrl {
      actions.append(UIAction(title: "打开链接", image: UIImage(systemName: "safari")) { [weak self] _ in self?.onAction("open") })
    }
    return UIMenu(children: actions)
  }
}
