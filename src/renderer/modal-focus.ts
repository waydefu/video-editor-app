import { useEffect } from "react";

const modalSelector = 'dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';
const controlSelector = "button, input, select, textarea, a[href], summary, video[controls], [tabindex]";

export function activeModal(): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>(modalSelector)).at(-1);
}

function tabbableControls(modal: HTMLElement): HTMLElement[] {
  return Array.from(modal.querySelectorAll<HTMLElement>(controlSelector)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      !element.closest("[hidden], [inert], details:not([open]) > :not(summary)") &&
      getComputedStyle(element).visibility !== "hidden" &&
      getComputedStyle(element).display !== "none",
  );
}

export function useModalFocus(): void {
  useEffect(() => {
    let current: HTMLElement | undefined;
    let lastOutside = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const returnTargets = new WeakMap<HTMLElement, HTMLElement>();
    const focusFirst = (modal: HTMLElement) => {
      if (!modal.hasAttribute("tabindex")) modal.tabIndex = -1;
      (tabbableControls(modal)[0] ?? modal).focus({ preventScroll: true });
    };
    const sync = () => {
      const next = activeModal();
      if (current === next) return;
      const prior = current;
      current = next;
      if (prior && (!next || !prior.contains(next))) {
        const returnTo = returnTargets.get(prior);
        if (returnTo?.isConnected && (!next || next.contains(returnTo))) {
          returnTo.focus({ preventScroll: true });
          window.requestAnimationFrame(() => {
            if (returnTo.isConnected && activeModal() === next && document.activeElement === document.body)
              returnTo.focus({ preventScroll: true });
          });
        }
      }
      if (!next) return;
      const focused = document.activeElement;
      const opener =
        focused instanceof HTMLElement && focused !== document.body && !next.contains(focused) ? focused : lastOutside;
      if (opener?.isConnected && !next.contains(opener)) returnTargets.set(next, opener);
      if (!next.contains(document.activeElement)) focusFirst(next);
    };
    const onFocus = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      const modal = activeModal();
      if (!modal || modal.contains(event.target)) {
        lastOutside = event.target;
      } else if (current === modal) {
        focusFirst(modal);
      }
    };
    const onTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      sync();
      if (!current) return;
      const controls = tabbableControls(current);
      const index = controls.indexOf(document.activeElement as HTMLElement);
      if (!controls.length || index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1)) {
        event.preventDefault();
        (controls[event.shiftKey ? controls.length - 1 : 0] ?? current).focus();
      }
    };
    const observer = new MutationObserver((mutations) => {
      if (current && !current.isConnected) {
        sync();
        return;
      }
      const modalChanged = mutations.some((mutation) =>
        mutation.type === "attributes"
          ? mutation.target instanceof HTMLDialogElement
          : Array.from(mutation.addedNodes).some(
              (node) => node instanceof Element && (node.matches(modalSelector) || node.querySelector(modalSelector)),
            ),
      );
      if (modalChanged) sync();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
    document.addEventListener("focusin", onFocus);
    document.addEventListener("keydown", onTab, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("keydown", onTab, true);
    };
  }, []);
}
