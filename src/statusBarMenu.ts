import { Menu, Notice, setIcon } from "obsidian";

import {
  buildStatusBarMenuItems,
  buildStatusBarPresentation,
  type StatusBarMenuActions,
  type StatusBarMenuItemDescriptor,
  type StatusBarMenuState,
  type StatusBarPresentation,
  dispatchStatusBarAction,
} from "./statusBarState";

export type {
  StatusBarMenuActions,
  StatusBarMenuItemDescriptor,
  StatusBarMenuState,
  StatusBarPresentation,
  StatusBarSchedulerDetail,
} from "./statusBarState";

export function configureStatusBarElement(element: HTMLElement, onOpen: (event?: MouseEvent | KeyboardEvent) => void): void {
  element.classList.add("mindmap-status");
  element.setAttribute("role", "button");
  element.setAttribute("tabindex", "0");
  element.setAttribute("aria-haspopup", "menu");
  element.setAttribute("aria-expanded", "false");
  element.addEventListener("click", (event) => onOpen(event));
  element.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    onOpen(event);
  });
}

export function renderStatusBarElement(element: HTMLElement, state: StatusBarMenuState): StatusBarPresentation {
  const presentation = buildStatusBarPresentation(state);
  element.classList.toggle("is-running", presentation.running);
  element.classList.toggle("is-animating", presentation.animateIcon);
  element.classList.toggle("is-actionable", presentation.actionable);
  element.replaceChildren();

  const icon = element.createSpan({ cls: "mindmap-status-icon", attr: { "aria-hidden": "true" } });
  setIcon(icon, presentation.icon);

  element.createSpan({ text: presentation.label });
  element.setAttribute("aria-label", presentation.ariaLabel);
  element.title = presentation.title;
  return presentation;
}

function addMenuItem(menu: Menu, descriptor: StatusBarMenuItemDescriptor, actions: StatusBarMenuActions): void {
  if (descriptor.label) {
    menu.addItem((item) => item.setTitle(descriptor.title).setIsLabel(true));
    return;
  }

  menu.addItem((item) => {
    item.setTitle(descriptor.title);
    if (descriptor.icon) item.setIcon(descriptor.icon);
    if (descriptor.checked !== undefined) item.setChecked(descriptor.checked);
    if (descriptor.disabled) item.setDisabled(true);
    const action = descriptor.action;
    if (action) {
      item.onClick(() => {
        if (action === "pauseProcessing") {
          void Promise.resolve(dispatchStatusBarAction(action, actions)).catch(() => new Notice("Mindmap action failed. Check the engine status and try again.", 8000));
        } else if (action === "resumeProcessing") {
          void Promise.resolve(dispatchStatusBarAction(action, actions)).catch(() => new Notice("Mindmap action failed. Check the engine status and try again.", 8000));
        } else if (action === "openNote" && descriptor.path) {
          void actions.openNote(descriptor.path);
        } else if (action === "runCurrent") {
          void actions.runCurrent();
        } else if (action === "runActiveNote") {
          void actions.runActiveNote();
        } else if (action === "runAll") {
          void actions.runAll();
        } else if (action === "processPendingNote" && descriptor.path) {
          void actions.processPendingNote(descriptor.path);
        } else if (action === "runPreflight") {
          void actions.runPreflight();
        } else if (action === "openMindmap") {
          void actions.openMindmap();
        } else if (action === "openSettings") {
          actions.openSettings();
        } else if (action === "selectStandardMode") {
          void actions.selectStandardMode();
        } else if (action === "selectReadingMode") {
          void actions.selectReadingMode();
        } else if (action === "syncReadingMode") {
          void actions.syncReadingMode();
        } else if (action === "processReadingBacklog") {
          void actions.processReadingBacklog();
        } else if (action === "toggleWebResearchMode") {
          void actions.toggleWebResearchMode();
        } else if (action === "researchSelectedText") {
          void actions.researchSelectedText();
        } else if (action === "researchActiveNote") {
          void actions.researchActiveNote();
        } else if (action === "researchAndReprocessActiveNote") {
          void actions.researchAndReprocessActiveNote();
        } else if (action === "toggleAutomaticReadingResearch") {
          void actions.toggleAutomaticReadingResearch();
        } else if (action === "retryAutomaticResearch") {
          void actions.retryAutomaticResearch();
        } else if (action === "startMigration") {
          void actions.startMigration();
        } else if (action === "retryMigration") {
          void actions.retryMigration();
        } else if (action === "cancelMigration") {
          void actions.cancelMigration();
        }
      });
    }
    return item;
  });
}

export function openStatusBarMenu(
  element: HTMLElement,
  state: StatusBarMenuState,
  actions: StatusBarMenuActions,
  event?: MouseEvent | KeyboardEvent,
): void {
  const menu = new Menu();
  menu.setUseNativeMenu(true);
  for (const [index, descriptor] of buildStatusBarMenuItems(state).entries()) {
    if (index > 0 && descriptor.label) {
      menu.addSeparator();
    }
    addMenuItem(menu, descriptor, actions);
  }

  element.setAttribute("aria-expanded", "true");
  menu.onHide(() => element.setAttribute("aria-expanded", "false"));
  if (event instanceof MouseEvent) {
    menu.showAtMouseEvent(event);
  } else {
    const rect = element.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom, width: rect.width });
  }
}
