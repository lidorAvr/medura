// "כבר הצטרפתי ממכשיר אחר" — sign in with the e-mail you verified, on any device.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { useStore, actions } from '../store.js?v=d288b77';
import { navigate } from '../router.js?v=d288b77';
import { Skeleton } from '../ui/components.js?v=d288b77';
import { EmailGate, linkThisDevice } from '../ui/email-gate.js?v=d288b77';

export default function SignInScreen() {
  const contact = useStore((s) => s.contact);
  const [checking, setChecking] = useState(Boolean(contact?.verified));

  // Already verified on this device → just link and go.
  useEffect(() => {
    if (!contact?.verified) return undefined;
    let alive = true;
    linkThisDevice().then((linked) => {
      if (!alive) return;
      const trips = linked.length ? linked : [];
      if (trips.length) {
        actions.toast('התחברת ✅ ברוכים השבים!', 'success', 3200);
        navigate(`/t/${trips[0].trip_id}`, { replace: true });
      } else setChecking(false);
    });
    return () => { alive = false; };
  }, []);

  if (checking) return html`<div class="screen gate"><${Skeleton} lines=${3} /></div>`;
  return html`<${EmailGate} mode="signin" />`;
}
