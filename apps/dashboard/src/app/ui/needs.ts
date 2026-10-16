import { Directive, ElementRef, computed, effect, inject, input } from '@angular/core';
import { Rights } from '../rights';

/**
 * `appNeeds="run.start"` on a button (or any control): when your role can't do that, it looks disabled,
 * says which role is needed on hover, and does nothing when clicked. The engine refuses it anyway.
 */
@Directive({
  selector: '[appNeeds]',
  host: { '[class.denied]': 'denied()', '[attr.aria-disabled]': "denied() ? 'true' : null", '[attr.data-needs]': 'appNeeds()' },
})
export class Needs {
  private readonly rights = inject(Rights);
  private readonly el = inject(ElementRef<HTMLElement>);
  readonly appNeeds = input.required<string>();
  /** Denied only once rights are known (until then the engine is the judge). */
  readonly denied = computed(() => this.rights.actions().size > 0 && !this.rights.can(this.appNeeds()));

  constructor() {
    const host = this.el.nativeElement;
    // Capture on the element itself runs before the template's own click handler.
    const stop = (e: Event) => {
      if (!this.denied()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    host.addEventListener('click', stop, true);
    host.addEventListener('change', stop, true);
    effect(() => {
      const why = this.rights.why(this.appNeeds());
      if (this.denied()) host.setAttribute('title', why);
      else if (host.getAttribute('title') === why || host.dataset['neededTitle']) host.removeAttribute('title');
    });
  }
}
