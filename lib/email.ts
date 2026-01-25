// lib/email.ts
// Minimal Resend email helper with safe fallbacks.

type SendArgs = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  cc?: string;
  replyTo?: string;
};

function hasEmailEnv() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export async function sendEmail({ to, subject, html, text, cc, replyTo }: SendArgs) {
  if (!hasEmailEnv()) {
    // Dev fallback: log instead of sending
    console.log("[email:DEV-FALLBACK]", { to, subject, html, text, cc, replyTo });
    return { ok: true, dev: true };
  }

  const apiKey = process.env.RESEND_API_KEY!;
  const from = process.env.EMAIL_FROM!;

  const payload: Record<string, any> = {
    from,
    to,
    subject,
    html,
    text,
  };
  
  if (cc) payload.cc = cc;
  if (replyTo) payload.reply_to = replyTo;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend failed (${res.status}): ${body || res.statusText}`);
  }

  return { ok: true };
}

export function makeResetEmail(resetUrl: string) {
  const subject = "Reset your MOS Maintenance password";
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
      <h2>Reset your password</h2>
      <p>Click the button below to reset your password. This link expires in ~30 minutes.</p>
      <p><a href="${resetUrl}" style="background:#111;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none;display:inline-block">Reset Password</a></p>
      <p>or copy/paste this URL:</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
    </div>`;
  const text = `Reset your password: ${resetUrl}`;
  return { subject, html, text };
}

export function makeInviteEmail(inviteUrl: string, shopId: number, role: string) {
  const subject = `You've been invited to MOS Maintenance (Shop #${shopId})`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
      <h2>You're invited</h2>
      <p>You've been invited to join Shop <b>#${shopId}</b> as <b>${role}</b>.</p>
      <p>Click below to complete your account setup.</p>
      <p><a href="${inviteUrl}" style="background:#111;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none;display:inline-block">Accept Invite</a></p>
      <p>or copy/paste this URL:</p>
      <p><a href="${inviteUrl}">${inviteUrl}</a></p>
    </div>`;
  const text = `Accept your invite: ${inviteUrl}`;
  return { subject, html, text };
}

export function makeProtractorApiRequestEmail(shopName: string, shopLocation: string, ownerEmail: string) {
  const subject = `${shopName} - API Access Request`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6">
      <p>Support,</p>
      
      <p>Please enable the My Oil Sticker API for <b>${shopName}</b> in ${shopLocation}. Owner is cc'd here.</p>
      
      <p>Also, in the actions please ensure <b>UpdateWorkOrderLine</b> and <b>UpdateWorkOrderPackage</b> are enabled and set to "Yes".</p>
      
      <p>Thank you,<br/>
      MOS Tools Team<br/>
      <a href="mailto:support@mos.tools">support@mos.tools</a><br/>
      <a href="https://mos.tools">mos.tools</a></p>
    </div>`;
  const text = `Support,

Please enable the My Oil Sticker API for ${shopName} in ${shopLocation}. Owner is cc'd here.

Also, in the actions please ensure UpdateWorkOrderLine and UpdateWorkOrderPackage are enabled and set to "Yes".

Thank you,
MOS Tools Team
support@mos.tools
mos.tools`;
  return { subject, html, text, to: "support@protractor.com", cc: ownerEmail };
}

export function makeTekmetricSetupEmail(shopName: string, ownerEmail: string) {
  const chromeExtensionUrl = "https://chromewebstore.google.com/detail/mos-tools/gkcehigbdlhjacjbgiffnlfhdnghlknd";
  const subject = `${shopName} - Tekmetric Integration Setup Instructions`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="text-align:center;margin-bottom:30px">
        <div style="display:inline-block;background:#2563eb;border-radius:12px;padding:12px">
          <span style="color:white;font-size:24px;font-weight:bold">MOS</span>
        </div>
      </div>
      
      <h1 style="color:#1f2937;font-size:24px;margin-bottom:16px">Tekmetric Integration Setup</h1>
      
      <p style="color:#4b5563;font-size:16px">
        Hello! Here are the steps to complete your MOS Tools integration with Tekmetric for <b>${shopName}</b>:
      </p>
      
      <h2 style="color:#1f2937;font-size:18px;margin-top:24px">Step 1: Enable the Integration in Tekmetric</h2>
      <ol style="color:#4b5563;font-size:16px;padding-left:20px">
        <li>Log in to your Tekmetric account</li>
        <li>Go to <b>Settings</b> → <b>Integrations</b></li>
        <li>Find <b>"My Oil Sticker"</b> in the list</li>
        <li>Click to enable the integration</li>
      </ol>
      
      <h2 style="color:#1f2937;font-size:18px;margin-top:24px">Step 2: Install the Chrome Extension</h2>
      <p style="color:#4b5563;font-size:16px">
        The MOS Tools Chrome extension adds maintenance plans and job history search directly inside Tekmetric.
      </p>
      
      <div style="text-align:center;margin:24px 0">
        <a href="${chromeExtensionUrl}" style="background:#2563eb;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;font-size:16px">Install Chrome Extension</a>
      </div>
      
      <p style="color:#6b7280;font-size:14px">
        Or copy this link: <a href="${chromeExtensionUrl}" style="color:#2563eb">${chromeExtensionUrl}</a>
      </p>
      
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:30px 0" />
      
      <p style="color:#4b5563;font-size:16px">
        Need help? Reply to this email or reach out to <a href="mailto:support@mos.tools" style="color:#2563eb">support@mos.tools</a>.
      </p>
      
      <p style="color:#9ca3af;font-size:14px;text-align:center;margin-top:30px">
        MOS Tools - Smarter Maintenance for Auto Shops<br />
        <a href="https://mos.tools" style="color:#2563eb">mos.tools</a>
      </p>
    </div>`;
  const text = `Tekmetric Integration Setup for ${shopName}

Step 1: Enable the Integration in Tekmetric
1. Log in to your Tekmetric account
2. Go to Settings → Integrations
3. Find "My Oil Sticker" in the list
4. Click to enable the integration

Step 2: Install the Chrome Extension
The MOS Tools Chrome extension adds maintenance plans and job history search directly inside Tekmetric.

Install here: ${chromeExtensionUrl}

Need help? Contact support@mos.tools`;
  return { subject, html, text, to: ownerEmail };
}

export function makeTicketCreatedEmail(ticketNumber: string, subject: string, category: string) {
  const emailSubject = `Support Ticket Created: ${ticketNumber}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="background:#3b82f6;color:white;padding:20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0">Support Ticket Created</h2>
      </div>
      <div style="background:#f8fafc;padding:20px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
        <p>Your support ticket has been submitted successfully. Our team will review it and respond as soon as possible.</p>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Ticket Number</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">${ticketNumber}</div>
        </div>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Subject</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">${subject}</div>
        </div>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Category</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">${category}</div>
        </div>
        <p style="margin-top:20px">You can view your ticket status and add comments in your dashboard.</p>
      </div>
      <p style="text-align:center;color:#94a3b8;font-size:12px;margin-top:20px">MOS Maintenance Support</p>
    </div>`;
  const text = `Support Ticket Created: ${ticketNumber}\n\nSubject: ${subject}\nCategory: ${category}\n\nYou can view your ticket status in your dashboard.`;
  return { subject: emailSubject, html, text };
}

export function makeTicketUpdatedEmail(ticketNumber: string, subject: string, status: string, message?: string) {
  const emailSubject = `Ticket Updated: ${ticketNumber}`;
  const statusColors: Record<string, string> = {
    'open': 'background:#dbeafe;color:#1d4ed8',
    'in progress': 'background:#fef3c7;color:#92400e',
    'resolved': 'background:#d1fae5;color:#065f46',
    'closed': 'background:#f1f5f9;color:#475569',
  };
  const statusStyle = statusColors[status.toLowerCase()] || 'background:#f1f5f9;color:#475569';
  
  const messageHtml = message ? `
    <div style="background:white;padding:15px;border-left:4px solid #3b82f6;border-radius:4px;margin:15px 0">
      <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase;margin-bottom:8px">New Message</div>
      <div style="white-space:pre-wrap">${message}</div>
    </div>
  ` : '';
  
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="background:#8b5cf6;color:white;padding:20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0">Ticket Updated</h2>
      </div>
      <div style="background:#f8fafc;padding:20px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
        <p>There's been an update to your support ticket.</p>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Ticket Number</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">${ticketNumber}</div>
        </div>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Subject</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">${subject}</div>
        </div>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Status</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">
            <span style="${statusStyle};padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600">${status}</span>
          </div>
        </div>
        ${messageHtml}
        <p style="margin-top:20px">Log in to your dashboard to view the full ticket details and respond.</p>
      </div>
      <p style="text-align:center;color:#94a3b8;font-size:12px;margin-top:20px">MOS Maintenance Support</p>
    </div>`;
  const text = `Ticket Updated: ${ticketNumber}\n\nSubject: ${subject}\nStatus: ${status}${message ? `\n\nNew Message:\n${message}` : ''}\n\nLog in to your dashboard to view details.`;
  return { subject: emailSubject, html, text };
}

export function makeNewTicketAdminEmail(ticketNumber: string, subject: string, category: string, priority: string, shopName: string) {
  const emailSubject = `New Support Ticket: ${ticketNumber} - ${subject}`;
  const priorityColors: Record<string, string> = {
    'urgent': 'background:#fee2e2;color:#dc2626',
    'high': 'background:#fed7aa;color:#ea580c',
    'medium': 'background:#fef3c7;color:#ca8a04',
    'low': 'background:#d1fae5;color:#059669',
  };
  const priorityStyle = priorityColors[priority.toLowerCase()] || 'background:#fef3c7;color:#ca8a04';
  
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="background:#dc2626;color:white;padding:20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0">New Support Ticket</h2>
      </div>
      <div style="background:#f8fafc;padding:20px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
        <p>A new support ticket has been submitted and requires attention.</p>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Ticket Number</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">${ticketNumber}</div>
        </div>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Shop</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">${shopName}</div>
        </div>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Subject</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">${subject}</div>
        </div>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Category</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">${category}</div>
        </div>
        <div style="background:white;padding:15px;border-radius:6px;margin:15px 0">
          <div style="font-weight:600;color:#64748b;font-size:12px;text-transform:uppercase">Priority</div>
          <div style="color:#1e293b;font-size:14px;margin-top:4px">
            <span style="${priorityStyle};padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600">${priority}</span>
          </div>
        </div>
        <p style="margin-top:20px">Log in to the Platform Admin panel to review and respond to this ticket.</p>
      </div>
      <p style="text-align:center;color:#94a3b8;font-size:12px;margin-top:20px">MOS Maintenance Platform</p>
    </div>`;
  const text = `New Support Ticket: ${ticketNumber}\n\nShop: ${shopName}\nSubject: ${subject}\nCategory: ${category}\nPriority: ${priority}\n\nLog in to Platform Admin to respond.`;
  return { subject: emailSubject, html, text };
}

export function makeWelcomeEmail(shopName: string, loginUrl: string) {
  const subject = `Welcome to MOS Tools!`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="text-align:center;margin-bottom:30px">
        <div style="display:inline-block;background:#2563eb;border-radius:12px;padding:12px">
          <span style="color:white;font-size:24px;font-weight:bold">MOS</span>
        </div>
      </div>
      
      <h1 style="color:#1f2937;font-size:24px;margin-bottom:16px">Welcome to MOS Tools!</h1>
      
      <p style="color:#4b5563;font-size:16px">
        Thank you for signing up <b>${shopName}</b> with MOS Tools. Your account is ready to go!
      </p>
      
      <p style="color:#4b5563;font-size:16px">
        With MOS Tools, you can:
      </p>
      
      <ul style="color:#4b5563;font-size:16px;padding-left:20px">
        <li>Get AI-powered maintenance recommendations for every vehicle</li>
        <li>Search job history across your shop (or enterprise)</li>
        <li>Track services and build customer trust</li>
        <li>Integrate with Tekmetric, Protractor, AutoFlow, and more</li>
      </ul>
      
      <div style="text-align:center;margin:30px 0">
        <a href="${loginUrl}" style="background:#2563eb;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;font-size:16px">Go to Dashboard</a>
      </div>
      
      <p style="color:#4b5563;font-size:16px">
        Need help getting started? Reply to this email or reach out to <a href="mailto:support@mos.tools" style="color:#2563eb">support@mos.tools</a>.
      </p>
      
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:30px 0" />
      
      <p style="color:#9ca3af;font-size:14px;text-align:center">
        MOS Tools - Smarter Maintenance for Auto Shops<br />
        <a href="https://mos.tools" style="color:#2563eb">mos.tools</a>
      </p>
    </div>`;
  const text = `Welcome to MOS Tools!\n\nThank you for signing up ${shopName}. Your account is ready.\n\nLog in: ${loginUrl}\n\nNeed help? Contact support@mos.tools`;
  return { subject, html, text };
}

export function makeAnnouncementEmail(title: string, message: string, priority: "info" | "warning" | "critical") {
  const priorityColors = {
    info: { bg: "#dbeafe", border: "#3b82f6", text: "#1e40af", label: "Information" },
    warning: { bg: "#fef3c7", border: "#f59e0b", text: "#92400e", label: "Important Notice" },
    critical: { bg: "#fee2e2", border: "#dc2626", text: "#991b1b", label: "Critical Alert" },
  };
  const colors = priorityColors[priority];
  
  const subject = priority === "critical" 
    ? `[CRITICAL] ${title}`
    : priority === "warning"
    ? `[IMPORTANT] ${title}`
    : title;
  
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
      <div style="text-align:center;margin-bottom:20px">
        <div style="display:inline-block;background:#2563eb;border-radius:12px;padding:12px">
          <span style="color:white;font-size:24px;font-weight:bold">MOS</span>
        </div>
      </div>
      
      <div style="background:${colors.bg};border-left:4px solid ${colors.border};padding:16px;border-radius:4px;margin-bottom:20px">
        <div style="font-size:12px;font-weight:600;color:${colors.text};text-transform:uppercase;margin-bottom:4px">${colors.label}</div>
        <h1 style="color:#1f2937;font-size:20px;margin:0">${title}</h1>
      </div>
      
      <div style="color:#4b5563;font-size:16px;white-space:pre-wrap">${message}</div>
      
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:30px 0" />
      
      <p style="color:#9ca3af;font-size:14px;text-align:center">
        This is an automated message from MOS Tools<br />
        <a href="https://mos.tools" style="color:#2563eb">mos.tools</a>
      </p>
    </div>`;
  const text = `[${colors.label}] ${title}\n\n${message}\n\n---\nThis is an automated message from MOS Tools`;
  return { subject, html, text };
}

export async function sendAnnouncementEmails(
  emails: string[],
  title: string,
  message: string,
  priority: "info" | "warning" | "critical"
): Promise<number> {
  if (!hasEmailEnv()) {
    console.log("[email:DEV-FALLBACK] Would send announcement to:", emails.length, "recipients");
    return emails.length;
  }

  const { subject, html, text } = makeAnnouncementEmail(title, message, priority);
  let sent = 0;
  
  const batchSize = 50;
  for (let i = 0; i < emails.length; i += batchSize) {
    const batch = emails.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map((email) => sendEmail({ to: email, subject, html, text }))
    );
    sent += results.filter((r) => r.status === "fulfilled").length;
  }

  return sent;
}

