export const DEFAULT_TRIAL_REMINDER_SUBJECT = "Action needed: {{daysLeft}} {{dayWord}} left in your MOS Tools trial";

export const DEFAULT_TRIAL_REMINDER_HTML = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="text-align:center;margin-bottom:24px">
        <div style="display:inline-block;background:#2563eb;border-radius:12px;padding:12px">
          <span style="color:white;font-size:24px;font-weight:bold">MOS</span>
        </div>
      </div>
      <h1 style="color:#1f2937;font-size:22px;margin-bottom:8px">Your trial ends in {{daysLeft}} {{dayWord}}</h1>
      <p style="color:#4b5563;font-size:16px">
        Hi from MOS Tools — your trial for <b>{{shopName}}</b> ends on <b>{{trialEndsAt}}</b>.
        To keep service running without interruption, add a payment method now. You won't be charged until the trial actually ends.
      </p>
      <div style="text-align:center;margin:24px 0">
        <a href="{{addCardUrl}}" style="background:#2563eb;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;font-size:16px">Add Payment Method</a>
      </div>
      <p style="color:#6b7280;font-size:14px">If you don't add a card before the trial ends, your dashboard will be locked until billing is set up.</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:30px 0" />
      <p style="color:#9ca3af;font-size:14px;text-align:center">MOS Tools<br /><a href="https://mos.tools" style="color:#2563eb">mos.tools</a></p>
    </div>`;

export const DEFAULT_TRIAL_REMINDER_TEXT = `Your MOS Tools trial for {{shopName}} ends in {{daysLeft}} {{dayWord}} (on {{trialEndsAt}}).\n\nAdd a payment method to keep service running without interruption — you won't be charged until the trial ends.\n\nAdd payment method: {{addCardUrl}}`;
