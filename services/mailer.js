import nodemailer from 'nodemailer'

const currencySymbols = { PKR: 'Rs.', USD: '$', EUR: '€', GBP: '£' }
function fmtCurrency(amount, currency) {
  const symbol = currencySymbols[currency] || currency || 'Rs.'
  return `${symbol} ${Number(amount).toLocaleString()}`
}

let transporter = null

function getTransporter() {
  if (transporter) return transporter

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  })

  return transporter
}

export async function notifyAdmin({ subject, html }) {
  try {
    const transport = getTransporter()
    await transport.sendMail({
      from: `"Hidaya Online" <${process.env.SMTP_USER}>`,
      to: process.env.NOTIFY_EMAIL,
      subject,
      html,
    })
    console.log(`Email sent to admin: ${subject}`)
  } catch (err) {
    console.error('Admin email failed:', err.message)
  }
}

export async function sendToUser({ to, subject, html }) {
  try {
    const transport = getTransporter()
    await transport.sendMail({
      from: `"Hidaya Online" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
    })
    console.log(`Email sent to user: ${to}`)
  } catch (err) {
    console.error('User email failed:', err.message)
  }
}

/* ─────────────────────────────────────────────────────
   SHARED LAYOUT — ADMIN EMAILS
   ───────────────────────────────────────────────────── */
function adminLayout(content) {
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f0f4f2;font-family:'Segoe UI',Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f2;padding:40px 16px">
    <tr><td align="center">
      <table role="presentation" width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%">
        <tr><td style="padding:0 0 24px" align="center">
          <img src="https://bexbucket.s3.eu-north-1.amazonaws.com/Logo/hidayaonlinelogo.jpeg" alt="Hidaya Online" width="140" style="display:block;height:auto;border:0;outline:0;text-decoration:none">
        </td></tr>
        <tr><td>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(12,59,46,0.06),0 8px 24px -8px rgba(12,59,46,0.08)">
            ${content}
          </table>
        </td></tr>
        <tr><td style="padding:32px 0 0" align="center">
          <span style="display:inline-block;width:32px;height:2px;background:linear-gradient(90deg,#D4A843,#1B6B5A);border-radius:1px"></span>
          <p style="color:#8AA89C;font-size:11px;line-height:18px;letter-spacing:0.3px;margin:12px 0 0">
            Hidaya Online<br>
            <a href="https://hidaya.online" style="color:#1B6B5A;text-decoration:none">hidaya.online</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

/* ─────────────────────────────────────────────────────
   SHARED LAYOUT — USER-FACING EMAILS (premium Islamic)
   ───────────────────────────────────────────────────── */
function userLayout(content) {
  return `
<!DOCTYPE html>
<html lang="en" dir="ltr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<link href="https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:#f0f4f2;font-family:'Segoe UI',Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f2;padding:40px 16px">
    <tr><td align="center">
      <table role="presentation" width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%">

        <!-- Logo -->
        <tr><td style="padding:0 0 24px" align="center">
          <img src="https://bexbucket.s3.eu-north-1.amazonaws.com/Logo/hidayaonlinelogo.jpeg" alt="Hidaya Online" width="140" style="display:block;height:auto;border:0;outline:0;text-decoration:none">
        </td></tr>

        <!-- Main card -->
        <tr><td>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 1px 3px rgba(12,59,46,0.06),0 12px 32px -8px rgba(12,59,46,0.10)">
            ${content}
          </table>
        </td></tr>

        <!-- Islamic star divider -->
        <tr><td style="padding:28px 0 0" align="center">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="width:60px;height:1px;background:linear-gradient(90deg,transparent,#D4A843)"></td>
            <td style="padding:0 12px"><span style="color:#D4A843;font-size:16px">✦</span></td>
            <td style="width:60px;height:1px;background:linear-gradient(90deg,#D4A843,transparent)"></td>
          </tr></table>
        </td></tr>

        <!-- Arabic blessing -->
        <tr><td style="padding:16px 0 4px" align="center">
          <p dir="rtl" style="margin:0;font-family:'Amiri',serif;font-size:22px;color:#0C3B2E;line-height:1.6">
            بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:8px 0 0" align="center">
          <p style="color:#8AA89C;font-size:11px;line-height:20px;letter-spacing:0.3px;margin:0">
            Hidaya Online
          </p>
          <p style="margin:10px 0 0">
            <a href="https://hidaya.online" style="color:#1B6B5A;text-decoration:none;font-size:12px;font-weight:600">hidaya.online</a>
            <span style="color:#D4A843;margin:0 8px">&middot;</span>
            <a href="https://wa.me/16313558368" style="color:#1B6B5A;text-decoration:none;font-size:12px;font-weight:600">WhatsApp</a>
            <span style="color:#D4A843;margin:0 8px">&middot;</span>
            <a href="tel:+16313558368" style="color:#1B6B5A;text-decoration:none;font-size:12px;font-weight:600">+1 631 355 8368</a>
          </p>
          <p style="color:#b0c4b8;font-size:10px;letter-spacing:0.5px;margin:14px 0 0">
            &copy; ${new Date().getFullYear()} Hidaya Online. All rights reserved.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`
}

/* ── Helper: info row ── */
function row(label, value, opts = {}) {
  if (!value) return ''
  const valueStyle = opts.bold
    ? 'font-size:22px;font-weight:700;color:#0C3B2E;letter-spacing:-0.3px'
    : opts.mono
      ? 'font-family:SFMono-Regular,Menlo,monospace;font-size:12px;color:#6B8F7F;letter-spacing:0.3px'
      : 'font-size:14px;color:#0C3B2E;font-weight:500'
  const link = opts.link ? `<a href="${opts.link}" style="${valueStyle};text-decoration:none">${value}</a>` : `<span style="${valueStyle}">${value}</span>`
  return `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid #f0f4f2;vertical-align:top">
        <span style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8AA89C;font-weight:600">${label}</span>
      </td>
      <td style="padding:14px 0;border-bottom:1px solid #f0f4f2;text-align:right;vertical-align:top">
        ${link}
      </td>
    </tr>`
}

const sourceStyle = {
  hero_form: { bg: '#E0F2FE', color: '#0369A1', label: 'Hero Form' },
  free_class: { bg: '#D1FAE5', color: '#047857', label: 'Free Class' },
  contact: { bg: '#FEF3C7', color: '#92400E', label: 'Contact Form' },
  enrollment: { bg: '#EDE9FE', color: '#6D28D9', label: 'Enrollment' },
}

/* ═══════════════════════════════════════════════════════
   ADMIN — ENROLLMENT NOTIFICATION
   ═══════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════
   USER — ADMISSION DECISION (approved / rejected)
   ═══════════════════════════════════════════════════════ */
export function admissionDecisionEmail({ studentName, approved, rollNo, reviewNotes }) {
  const headline = approved ? 'Admission Approved!' : 'Admission Update'
  const badge = approved
    ? '<span style="display:inline-block;padding:5px 14px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:0.5px;background:#ECFDF5;color:#059669;text-transform:uppercase">Approved</span>'
    : '<span style="display:inline-block;padding:5px 14px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:0.5px;background:#FEF2F2;color:#DC2626;text-transform:uppercase">Not Approved</span>'
  const lead = approved
    ? `Assalamu Alaikum! We are delighted to let you know that the admission application for <b style="color:#0C3B2E">${studentName}</b> has been approved. Welcome to the Hidaya Online family!`
    : `Assalamu Alaikum. Thank you for applying to Hidaya Online. After careful review, we are unable to approve the admission application for <b style="color:#0C3B2E">${studentName}</b> at this time.`

  const content = `
    <tr><td style="height:4px;background:linear-gradient(90deg,#0C3B2E,#1B6B5A,#D4A843)"></td></tr>
    <tr><td style="padding:32px 36px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td>${badge}</td>
        <td align="right"><span style="font-size:11px;color:#8AA89C;font-family:SFMono-Regular,Menlo,monospace">${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span></td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:20px 36px 4px">
      <h1 style="margin:0;font-size:24px;font-weight:700;color:#0C3B2E">${headline}</h1>
      <p style="margin:10px 0 0;font-size:14px;line-height:1.7;color:#4B6357">${lead}</p>
    </td></tr>
    ${approved && rollNo ? `
    <tr><td style="padding:22px 36px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5FAF7;border:1px solid #DBEDE3;border-radius:12px">
        <tr><td style="padding:16px 20px">
          <span style="font-size:11px;font-weight:700;letter-spacing:1px;color:#6B8F7F;text-transform:uppercase">Student Roll Number</span><br>
          <span style="font-size:20px;font-weight:700;color:#0C3B2E;font-family:SFMono-Regular,Menlo,monospace">${rollNo}</span>
        </td></tr>
      </table>
      <p style="margin:14px 0 0;font-size:13px;line-height:1.7;color:#4B6357">Our team will reach out shortly with class schedule details and next steps. Please keep this roll number for your records.</p>
    </td></tr>` : ''}
    ${!approved && reviewNotes ? `
    <tr><td style="padding:22px 36px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:12px">
        <tr><td style="padding:16px 20px">
          <span style="font-size:11px;font-weight:700;letter-spacing:1px;color:#92400E;text-transform:uppercase">Note from our team</span><br>
          <span style="font-size:13px;line-height:1.7;color:#4B6357">${reviewNotes}</span>
        </td></tr>
      </table>
      <p style="margin:14px 0 0;font-size:13px;line-height:1.7;color:#4B6357">You are welcome to apply again or contact us if you have any questions — we would be glad to help.</p>
    </td></tr>` : ''}
    <tr><td style="padding:26px 36px 36px" align="center">
      <a href="https://hidaya.online" style="display:inline-block;padding:14px 40px;background:linear-gradient(135deg,#0C3B2E,#1B6B5A);color:#fff;font-size:14px;font-weight:600;text-decoration:none;border-radius:12px;box-shadow:0 4px 12px rgba(12,59,46,0.25)">Visit Hidaya Online</a>
    </td></tr>`

  return {
    subject: approved
      ? `🎓 Admission Approved — Welcome to Hidaya Online, ${studentName}!`
      : `Admission Update — ${studentName}`,
    html: userLayout(content),
  }
}

/* ═══════════════════════════════════════════════════════
   USER — STUDENT PORTAL ACCOUNT WELCOME (credentials)
   ═══════════════════════════════════════════════════════ */
export function portalWelcomeEmail({ displayName, email, password, rollNo }) {
  const firstName = (displayName || 'Student').split(' ')[0]
  const loginUrl = `${process.env.FRONTEND_URL || 'https://hidaya.online'}/portal/login`

  const content = `
    <!-- Accent bar -->
    <tr><td style="height:4px;background:linear-gradient(90deg,#0C3B2E,#1B6B5A,#D4A843)"></td></tr>

    <!-- Arabic header -->
    <tr><td style="padding:36px 36px 0" align="center">
      <p dir="rtl" style="margin:0;font-family:'Amiri',serif;font-size:28px;color:#0C3B2E;line-height:1.4">
        ٱقْرَأْ بِٱسْمِ رَبِّكَ ٱلَّذِى خَلَقَ
      </p>
      <p style="margin:6px 0 0;font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#8AA89C;font-weight:500">
        Read in the name of your Lord who created &mdash; Al-Alaq 96:1
      </p>
    </td></tr>

    <!-- Divider -->
    <tr><td style="padding:20px 36px 0" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:80px;height:1px;background:linear-gradient(90deg,transparent,#D4A843)"></td>
        <td style="padding:0 10px"><span style="color:#D4A843;font-size:12px">✦</span></td>
        <td style="width:80px;height:1px;background:linear-gradient(90deg,#D4A843,transparent)"></td>
      </tr></table>
    </td></tr>

    <!-- Greeting -->
    <tr><td style="padding:24px 36px 0" align="center">
      <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:2.5px;color:#D4A843;font-weight:700">أهلاً وسهلاً</p>
      <p style="margin:4px 0 0;font-size:11px;color:#8AA89C;letter-spacing:0.5px;font-style:italic">Welcome</p>
      <h1 style="margin:10px 0 0;font-size:28px;font-weight:700;color:#0C3B2E;letter-spacing:-0.3px;font-family:'Amiri',serif">
        Your Student Portal is Ready, ${firstName}
      </h1>
      <p style="margin:12px 0 0;font-size:15px;color:#6B8F7F;line-height:1.6;max-width:420px">
        A student portal account has been created for you at Hidaya Online. Use the credentials below to sign in and follow your learning journey.
      </p>
    </td></tr>

    <!-- Credentials card -->
    <tr><td style="padding:28px 36px 8px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#F8FAF9,#F0F7F4);border-radius:16px;border:1px solid #E7F2EC">
        <tr><td style="padding:24px 28px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${row('Email', email)}
            <tr>
              <td style="padding:14px 0;border-bottom:1px solid #f0f4f2;vertical-align:top">
                <span style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8AA89C;font-weight:600">Temporary Password</span>
              </td>
              <td style="padding:14px 0;border-bottom:1px solid #f0f4f2;text-align:right;vertical-align:top">
                <span style="display:inline-block;padding:6px 14px;background:#0C3B2E;color:#fff;border-radius:8px;font-family:SFMono-Regular,Menlo,monospace;font-size:15px;font-weight:700;letter-spacing:0.5px">${password}</span>
              </td>
            </tr>
            ${rollNo ? row('Roll Number', rollNo, { mono: true }) : ''}
          </table>
        </td></tr>
      </table>
    </td></tr>

    <!-- Security note -->
    <tr><td style="padding:8px 36px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:12px">
        <tr><td style="padding:14px 18px">
          <span style="font-size:13px;line-height:1.6;color:#92400E">🔒 For your security, please log in and change this temporary password from your profile.</span>
        </td></tr>
      </table>
    </td></tr>

    <!-- CTA -->
    <tr><td style="padding:24px 36px 16px" align="center">
      <a href="${loginUrl}" style="display:inline-block;padding:16px 48px;background:linear-gradient(135deg,#0C3B2E,#1B6B5A);color:#fff;font-size:16px;font-weight:700;text-decoration:none;border-radius:14px;box-shadow:0 4px 20px rgba(12,59,46,0.3);letter-spacing:0.3px">
        Log in to Portal
      </a>
    </td></tr>

    <!-- Closing -->
    <tr><td style="padding:16px 36px 32px" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:40px;height:1px;background:linear-gradient(90deg,transparent,#E7F2EC)"></td>
        <td style="padding:0 12px"><span style="color:#D4A843;font-size:10px">✦</span></td>
        <td style="width:40px;height:1px;background:linear-gradient(90deg,#E7F2EC,transparent)"></td>
      </tr></table>
      <p dir="rtl" style="margin:12px 0 0;font-family:'Amiri',serif;font-size:18px;color:#0C3B2E">بَارَكَ اللَّهُ فِيكُمْ</p>
      <p style="margin:4px 0 0;font-size:11px;color:#8AA89C;letter-spacing:0.5px;font-style:italic">May Allah bless you</p>
    </td></tr>`

  return {
    subject: `🕌 Your Hidaya Online Student Portal Account`,
    html: userLayout(content),
  }
}

/* ═══════════════════════════════════════════════════════
   USER — PASSWORD RESET OTP
   ═══════════════════════════════════════════════════════ */
export function passwordResetOtpEmail({ displayName, otp }) {
  const firstName = (displayName || 'there').split(' ')[0]

  const content = `
    <!-- Accent bar -->
    <tr><td style="height:4px;background:linear-gradient(90deg,#0C3B2E,#1B6B5A,#D4A843)"></td></tr>

    <!-- Header -->
    <tr><td style="padding:36px 36px 0" align="center">
      <span style="display:inline-block;padding:5px 14px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:0.5px;background:#EDE9FE;color:#6D28D9;text-transform:uppercase">Password Reset</span>
      <h1 style="margin:18px 0 0;font-size:26px;font-weight:700;color:#0C3B2E;font-family:'Amiri',serif">
        Reset Your Password, ${firstName}
      </h1>
      <p style="margin:12px 0 0;font-size:15px;color:#6B8F7F;line-height:1.6;max-width:420px">
        Use the one-time code below to reset your Hidaya Online portal password. This code expires in 10 minutes.
      </p>
    </td></tr>

    <!-- OTP card -->
    <tr><td style="padding:28px 36px 8px" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#F8FAF9,#F0F7F4);border-radius:16px;border:1px solid #E7F2EC">
        <tr><td style="padding:24px 40px" align="center">
          <span style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#8AA89C;font-weight:600;margin-bottom:10px">Your Code</span>
          <span style="font-size:40px;font-weight:800;color:#0C3B2E;letter-spacing:10px;font-family:SFMono-Regular,Menlo,monospace">${otp}</span>
        </td></tr>
      </table>
    </td></tr>

    <!-- Security note -->
    <tr><td style="padding:16px 36px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:12px">
        <tr><td style="padding:14px 18px">
          <span style="font-size:13px;line-height:1.6;color:#92400E">🔒 If you did not request a password reset, you can safely ignore this email — your password will remain unchanged.</span>
        </td></tr>
      </table>
    </td></tr>

    <!-- Closing -->
    <tr><td style="padding:26px 36px 32px" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:40px;height:1px;background:linear-gradient(90deg,transparent,#E7F2EC)"></td>
        <td style="padding:0 12px"><span style="color:#D4A843;font-size:10px">✦</span></td>
        <td style="width:40px;height:1px;background:linear-gradient(90deg,#E7F2EC,transparent)"></td>
      </tr></table>
      <p dir="rtl" style="margin:12px 0 0;font-family:'Amiri',serif;font-size:18px;color:#0C3B2E">بَارَكَ اللَّهُ فِيكُمْ</p>
      <p style="margin:4px 0 0;font-size:11px;color:#8AA89C;letter-spacing:0.5px;font-style:italic">May Allah bless you</p>
    </td></tr>`

  return {
    subject: `🔐 Your Hidaya Online password reset code: ${otp}`,
    html: userLayout(content),
  }
}

export function enrollmentEmail(data) {
  const src = sourceStyle[data.source] || sourceStyle.enrollment
  const isContact = data.source === 'contact'

  const content = `
    <tr><td style="height:4px;background:linear-gradient(90deg,#0C3B2E,#1B6B5A,#D4A843)"></td></tr>
    <tr><td style="padding:32px 36px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td><span style="display:inline-block;padding:5px 14px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:0.5px;background:${src.bg};color:${src.color};text-transform:uppercase">${src.label}</span></td>
        <td align="right"><span style="font-size:11px;color:#8AA89C;font-family:SFMono-Regular,Menlo,monospace">${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span></td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:20px 36px 4px">
      <h1 style="margin:0;font-size:24px;font-weight:700;color:#0C3B2E">New ${isContact ? 'Message' : 'Enrollment Request'}</h1>
      <p style="margin:6px 0 0;font-size:14px;color:#6B8F7F">A new submission has been received from the website.</p>
    </td></tr>
    <tr><td style="padding:20px 36px 0"><div style="height:1px;background:linear-gradient(90deg,transparent,#e5e7eb,transparent)"></div></td></tr>
    <tr><td style="padding:8px 36px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${row('Name', data.name)}
        ${row('Email', data.email, { link: `mailto:${data.email}` })}
        ${row('Phone', data.phone, { link: `tel:${data.phone}` })}
        ${data.message ? row('Message', data.message) : ''}
      </table>
    </td></tr>
    <tr><td style="padding:0 36px 36px" align="center">
      <a href="mailto:${data.email}" style="display:inline-block;padding:14px 40px;background:linear-gradient(135deg,#0C3B2E,#1B6B5A);color:#fff;font-size:14px;font-weight:600;text-decoration:none;border-radius:12px;box-shadow:0 4px 12px rgba(12,59,46,0.25)">Reply to ${data.name.split(' ')[0]}</a>
    </td></tr>`

  return {
    subject: `${isContact ? '💬' : '🎓'} New ${isContact ? 'Contact' : 'Enrollment'} — ${data.name}`,
    html: adminLayout(content),
  }
}

/* ═══════════════════════════════════════════════════════
   USER — ENROLLMENT CONFIRMATION (Islamic themed)
   ═══════════════════════════════════════════════════════ */
export function enrollmentConfirmationEmail(data) {
  const isContact = data.source === 'contact'
  const isFreeClass = data.source === 'free_class'
  const firstName = data.name.split(' ')[0]

  let heading, subtext, whatNext
  if (isContact) {
    heading = 'Message Received'
    subtext = 'We have received your message and our team will get back to you shortly, In shaa Allah.'
    whatNext = [
      { icon: '📩', title: 'We\'ll reply soon', desc: 'Our team reviews every message and responds within 24 hours.' },
      { icon: '💬', title: 'Prefer WhatsApp?', desc: 'You can also reach us directly on WhatsApp for a faster response.' },
      { icon: '📚', title: 'Explore our courses', desc: 'While you wait, feel free to browse our Quran learning programs.' },
    ]
  } else if (isFreeClass) {
    heading = 'Free Trial Booked'
    subtext = 'Your request for a free 30-minute Quran class has been received. We will confirm your schedule shortly, In shaa Allah.'
    whatNext = [
      { icon: '📅', title: 'Schedule confirmation', desc: 'We\'ll check teacher availability and confirm a time that suits you.' },
      { icon: '💬', title: 'WhatsApp details', desc: 'You\'ll receive class details and a Google Meet link via WhatsApp.' },
      { icon: '🧑‍🏫', title: 'Your free session', desc: 'A 30-minute one-on-one class where we assess your level and goals.' },
    ]
  } else {
    heading = 'Enrollment Received'
    subtext = 'Your enrollment request has been received. Our team will review your details and reach out soon, In shaa Allah.'
    whatNext = [
      { icon: '📞', title: 'We\'ll contact you', desc: 'Our enrollment team will call or email you to discuss your learning plan.' },
      { icon: '🎯', title: 'Personalized plan', desc: 'We\'ll match you with the right course and teacher for your goals.' },
      { icon: '🕌', title: 'Begin your journey', desc: 'Start learning the Quran with expert guidance from qualified teachers.' },
    ]
  }

  const whatNextCards = whatNext.map(w => `
    <td style="width:33.33%;padding:0 6px;vertical-align:top">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAF9;border-radius:12px;border:1px solid #E7F2EC">
        <tr><td style="padding:20px 16px;text-align:center">
          <span style="font-size:24px;display:block;margin-bottom:10px">${w.icon}</span>
          <span style="font-size:13px;font-weight:700;color:#0C3B2E;display:block;margin-bottom:6px">${w.title}</span>
          <span style="font-size:12px;color:#6B8F7F;line-height:1.5">${w.desc}</span>
        </td></tr>
      </table>
    </td>`).join('')

  const content = `
    <!-- Accent bar -->
    <tr><td style="height:4px;background:linear-gradient(90deg,#0C3B2E,#1B6B5A,#D4A843)"></td></tr>

    <!-- Arabic calligraphy header -->
    <tr><td style="padding:36px 36px 0" align="center">
      <p dir="rtl" style="margin:0;font-family:'Amiri',serif;font-size:28px;color:#0C3B2E;line-height:1.4">
        ٱقْرَأْ بِٱسْمِ رَبِّكَ ٱلَّذِى خَلَقَ
      </p>
      <p style="margin:6px 0 0;font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#8AA89C;font-weight:500">
        Read in the name of your Lord who created &mdash; Al-Alaq 96:1
      </p>
    </td></tr>

    <!-- Decorative divider -->
    <tr><td style="padding:20px 36px 0" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:80px;height:1px;background:linear-gradient(90deg,transparent,#D4A843)"></td>
        <td style="padding:0 10px"><span style="color:#D4A843;font-size:12px">✦</span></td>
        <td style="width:80px;height:1px;background:linear-gradient(90deg,#D4A843,transparent)"></td>
      </tr></table>
    </td></tr>

    <!-- Greeting -->
    <tr><td style="padding:24px 36px 0" align="center">
      <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:2.5px;color:#D4A843;font-weight:700">
        أهلاً وسهلاً
      </p>
      <p style="margin:4px 0 0;font-size:11px;color:#8AA89C;letter-spacing:0.5px;font-style:italic">Welcome</p>
      <h1 style="margin:10px 0 0;font-size:28px;font-weight:700;color:#0C3B2E;letter-spacing:-0.3px;font-family:'Amiri',serif">
        ${heading}, ${firstName}
      </h1>
      <p style="margin:12px 0 0;font-size:15px;color:#6B8F7F;line-height:1.6;max-width:420px">
        ${subtext}
      </p>
    </td></tr>

    <!-- Summary card -->
    <tr><td style="padding:28px 36px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#F8FAF9,#F0F7F4);border-radius:14px;border:1px solid #E7F2EC">
        <tr><td style="padding:24px 28px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:8px 0;border-bottom:1px solid #E7F2EC">
                <span style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8AA89C;font-weight:600">Name</span>
              </td>
              <td style="padding:8px 0;border-bottom:1px solid #E7F2EC;text-align:right">
                <span style="font-size:14px;color:#0C3B2E;font-weight:600">${data.name}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 0;border-bottom:1px solid #E7F2EC">
                <span style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8AA89C;font-weight:600">Email</span>
              </td>
              <td style="padding:8px 0;border-bottom:1px solid #E7F2EC;text-align:right">
                <span style="font-size:14px;color:#0C3B2E;font-weight:500">${data.email}</span>
              </td>
            </tr>
            ${data.phone ? `<tr>
              <td style="padding:8px 0">
                <span style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8AA89C;font-weight:600">Phone</span>
              </td>
              <td style="padding:8px 0;text-align:right">
                <span style="font-size:14px;color:#0C3B2E;font-weight:500">${data.phone}</span>
              </td>
            </tr>` : ''}
          </table>
        </td></tr>
      </table>
    </td></tr>

    <!-- What happens next -->
    <tr><td style="padding:0 36px 8px">
      <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#8AA89C;font-weight:700;text-align:center">What happens next</p>
    </td></tr>
    <tr><td style="padding:8px 30px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${whatNextCards}</tr></table>
    </td></tr>

    <!-- CTA -->
    <tr><td style="padding:0 36px 16px" align="center">
      <a href="https://wa.me/16313558368" style="display:inline-block;padding:14px 40px;background:linear-gradient(135deg,#0C3B2E,#1B6B5A);color:#fff;font-size:14px;font-weight:600;text-decoration:none;border-radius:12px;box-shadow:0 4px 16px rgba(12,59,46,0.25);letter-spacing:0.2px">
        Contact Us on WhatsApp
      </a>
    </td></tr>

    <!-- Closing blessing -->
    <tr><td style="padding:16px 36px 32px" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:40px;height:1px;background:linear-gradient(90deg,transparent,#E7F2EC)"></td>
        <td style="padding:0 12px"><span style="color:#D4A843;font-size:10px">✦</span></td>
        <td style="width:40px;height:1px;background:linear-gradient(90deg,#E7F2EC,transparent)"></td>
      </tr></table>
      <p dir="rtl" style="margin:12px 0 0;font-family:'Amiri',serif;font-size:18px;color:#0C3B2E;line-height:1.5">
        بَارَكَ اللَّهُ فِيكُمْ
      </p>
      <p style="margin:4px 0 0;font-size:11px;color:#8AA89C;letter-spacing:0.5px;font-style:italic">
        May Allah bless you
      </p>
    </td></tr>`

  return {
    subject: `Ahlan wa Sahlan — ${heading}, ${firstName}`,
    html: userLayout(content),
  }
}

/* ═══════════════════════════════════════════════════════
   ADMIN — PAYMENT NOTIFICATION
   ═══════════════════════════════════════════════════════ */
export function paymentEmail(data) {
  const isSuccess = data.status === 'completed'
  const statusBg = isSuccess ? '#D1FAE5' : '#FEE2E2'
  const statusColor = isSuccess ? '#047857' : '#DC2626'
  const statusIcon = isSuccess ? '✓' : '✕'
  const accentBar = isSuccess
    ? 'linear-gradient(90deg,#047857,#059669,#10B981)'
    : 'linear-gradient(90deg,#DC2626,#EF4444,#F87171)'

  const content = `
    <tr><td style="height:4px;background:${accentBar}"></td></tr>
    <tr><td style="padding:32px 36px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td><span style="display:inline-block;padding:5px 14px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:0.5px;background:${statusBg};color:${statusColor};text-transform:uppercase">${statusIcon} ${data.status}</span></td>
        <td align="right"><span style="font-size:11px;color:#8AA89C;font-family:SFMono-Regular,Menlo,monospace">${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span></td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:20px 36px 4px">
      <h1 style="margin:0;font-size:24px;font-weight:700;color:#0C3B2E">Payment ${isSuccess ? 'Received' : 'Failed'}</h1>
      <p style="margin:6px 0 0;font-size:14px;color:#6B8F7F">${isSuccess ? 'A payment has been successfully processed.' : 'A payment attempt was unsuccessful.'}</p>
    </td></tr>
    <tr><td style="padding:24px 36px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${isSuccess ? '#F0FDF9' : '#FFF5F5'};border-radius:14px;border:1px solid ${isSuccess ? '#D1FAE5' : '#FECACA'}">
        <tr><td style="padding:24px 28px" align="center">
          <span style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#8AA89C;font-weight:600;margin-bottom:8px">Amount</span>
          <span style="font-size:36px;font-weight:800;color:${statusColor};letter-spacing:-0.5px">${fmtCurrency(data.amount, data.currency)}</span>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:0 36px"><div style="height:1px;background:linear-gradient(90deg,transparent,#e5e7eb,transparent)"></div></td></tr>
    <tr><td style="padding:8px 36px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${row('Student', data.studentName)}
        ${row('Email', data.studentEmail, { link: `mailto:${data.studentEmail}` })}
        ${row('Plan', data.plan)}
        ${data.quantity > 1 ? row('Students', `${data.quantity} students`) : ''}
        ${data.studentNames?.length > 0 ? row('Student Names', data.studentNames.join(', ')) : ''}
        ${row('Order ID', data.gatewayOrderId || '—', { mono: true })}
        ${data.gatewayTransactionId ? row('Transaction ID', data.gatewayTransactionId, { mono: true }) : ''}
      </table>
    </td></tr>
    <tr><td style="padding:0 36px 36px" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="padding-right:8px">
          <a href="mailto:${data.studentEmail}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#0C3B2E,#1B6B5A);color:#fff;font-size:13px;font-weight:600;text-decoration:none;border-radius:12px;box-shadow:0 4px 12px rgba(12,59,46,0.25)">Email Student</a>
        </td>
        ${data.studentPhone ? `<td>
          <a href="https://wa.me/${data.studentPhone.replace(/[^0-9]/g, '')}" style="display:inline-block;padding:14px 32px;background:#25D366;color:#fff;font-size:13px;font-weight:600;text-decoration:none;border-radius:12px;box-shadow:0 4px 12px rgba(37,211,102,0.25)">WhatsApp</a>
        </td>` : ''}
      </tr></table>
    </td></tr>`

  return {
    subject: `${isSuccess ? '✅' : '❌'} Payment ${data.status} — ${data.studentName}${data.quantity > 1 ? ` (×${data.quantity})` : ''} (${fmtCurrency(data.amount, data.currency)})`,
    html: adminLayout(content),
  }
}

/* ═══════════════════════════════════════════════════════
   USER — PAYMENT CONFIRMATION (Islamic themed)
   ═══════════════════════════════════════════════════════ */
export function paymentConfirmationEmail(data) {
  const isSuccess = data.status === 'completed'
  const firstName = data.studentName.split(' ')[0]
  const statusColor = isSuccess ? '#047857' : '#DC2626'

  const content = `
    <!-- Accent bar -->
    <tr><td style="height:4px;background:linear-gradient(90deg,#0C3B2E,#1B6B5A,#D4A843)"></td></tr>

    <!-- Arabic header -->
    <tr><td style="padding:36px 36px 0" align="center">
      <p dir="rtl" style="margin:0;font-family:'Amiri',serif;font-size:28px;color:#0C3B2E;line-height:1.4">
        ٱقْرَأْ بِٱسْمِ رَبِّكَ ٱلَّذِى خَلَقَ
      </p>
      <p style="margin:6px 0 0;font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#8AA89C;font-weight:500">
        Read in the name of your Lord who created &mdash; Al-Alaq 96:1
      </p>
    </td></tr>

    <!-- Divider -->
    <tr><td style="padding:20px 36px 0" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:80px;height:1px;background:linear-gradient(90deg,transparent,#D4A843)"></td>
        <td style="padding:0 10px"><span style="color:#D4A843;font-size:12px">✦</span></td>
        <td style="width:80px;height:1px;background:linear-gradient(90deg,#D4A843,transparent)"></td>
      </tr></table>
    </td></tr>

    <!-- Greeting -->
    <tr><td style="padding:24px 36px 0" align="center">
      <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:2.5px;color:#D4A843;font-weight:700">
        بَارَكَ اللَّهُ فِيكُمْ
      </p>
      <p style="margin:4px 0 0;font-size:11px;color:#8AA89C;letter-spacing:0.5px;font-style:italic">May Allah bless you</p>
      <h1 style="margin:10px 0 0;font-size:28px;font-weight:700;color:#0C3B2E;font-family:'Amiri',serif">
        ${isSuccess ? `Payment Confirmed, ${firstName}` : `Payment Issue, ${firstName}`}
      </h1>
      <p style="margin:12px 0 0;font-size:15px;color:#6B8F7F;line-height:1.6;max-width:420px">
        ${isSuccess
          ? 'Your payment has been successfully received. May your journey of learning the Quran be blessed and fruitful.'
          : 'Unfortunately your payment could not be processed. Please try again or contact us for assistance.'}
      </p>
    </td></tr>

    <!-- Amount card -->
    <tr><td style="padding:28px 36px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${isSuccess ? 'linear-gradient(135deg,#F0FDF9,#E6F7F0)' : 'linear-gradient(135deg,#FFF5F5,#FEF2F2)'};border-radius:16px;border:1px solid ${isSuccess ? '#D1FAE5' : '#FECACA'}">
        <tr><td style="padding:28px" align="center">
          <span style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#8AA89C;font-weight:600;margin-bottom:8px">Amount ${isSuccess ? 'Paid' : 'Attempted'}</span>
          <span style="font-size:40px;font-weight:800;color:${statusColor};letter-spacing:-0.5px">${fmtCurrency(data.amount, data.currency)}</span>
          <span style="display:block;margin-top:8px;font-size:13px;color:#6B8F7F">${data.plan}</span>
        </td></tr>
      </table>
    </td></tr>

    <!-- Details -->
    <tr><td style="padding:0 36px 8px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAF9;border-radius:14px;border:1px solid #E7F2EC">
        <tr><td style="padding:20px 24px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:8px 0;border-bottom:1px solid #E7F2EC"><span style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8AA89C;font-weight:600">Registered By</span></td>
              <td style="padding:8px 0;border-bottom:1px solid #E7F2EC;text-align:right"><span style="font-size:14px;color:#0C3B2E;font-weight:600">${data.studentName}</span></td>
            </tr>
            ${data.quantity > 1 ? `<tr>
              <td style="padding:8px 0;border-bottom:1px solid #E7F2EC"><span style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8AA89C;font-weight:600">Students</span></td>
              <td style="padding:8px 0;border-bottom:1px solid #E7F2EC;text-align:right"><span style="font-size:14px;color:#0C3B2E;font-weight:600">${data.quantity} students</span></td>
            </tr>` : ''}
            ${data.studentNames?.length > 0 ? `<tr>
              <td style="padding:8px 0;border-bottom:1px solid #E7F2EC"><span style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8AA89C;font-weight:600">Student Names</span></td>
              <td style="padding:8px 0;border-bottom:1px solid #E7F2EC;text-align:right"><span style="font-size:13px;color:#0C3B2E;font-weight:500">${data.studentNames.join(', ')}</span></td>
            </tr>` : ''}
            <tr>
              <td style="padding:8px 0;border-bottom:1px solid #E7F2EC"><span style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8AA89C;font-weight:600">Order ID</span></td>
              <td style="padding:8px 0;border-bottom:1px solid #E7F2EC;text-align:right"><span style="font-family:SFMono-Regular,Menlo,monospace;font-size:12px;color:#6B8F7F">${data.gatewayOrderId || '—'}</span></td>
            </tr>
            <tr>
              <td style="padding:8px 0"><span style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8AA89C;font-weight:600">Status</span></td>
              <td style="padding:8px 0;text-align:right"><span style="display:inline-block;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;background:${isSuccess ? '#D1FAE5' : '#FEE2E2'};color:${statusColor};text-transform:uppercase">${data.status}</span></td>
            </tr>
          </table>
        </td></tr>
      </table>
    </td></tr>

    ${isSuccess ? `
    <!-- What happens next -->
    <tr><td style="padding:20px 36px 8px">
      <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#8AA89C;font-weight:700;text-align:center">What happens next</p>
    </td></tr>
    <tr><td style="padding:8px 30px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="width:33.33%;padding:0 6px;vertical-align:top">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAF9;border-radius:12px;border:1px solid #E7F2EC">
            <tr><td style="padding:20px 16px;text-align:center">
              <span style="font-size:24px;display:block;margin-bottom:10px">📅</span>
              <span style="font-size:13px;font-weight:700;color:#0C3B2E;display:block;margin-bottom:6px">Schedule setup</span>
              <span style="font-size:12px;color:#6B8F7F;line-height:1.5">We'll arrange your class schedule based on your selected plan.</span>
            </td></tr>
          </table>
        </td>
        <td style="width:33.33%;padding:0 6px;vertical-align:top">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAF9;border-radius:12px;border:1px solid #E7F2EC">
            <tr><td style="padding:20px 16px;text-align:center">
              <span style="font-size:24px;display:block;margin-bottom:10px">🧑‍🏫</span>
              <span style="font-size:13px;font-weight:700;color:#0C3B2E;display:block;margin-bottom:6px">Teacher assigned</span>
              <span style="font-size:12px;color:#6B8F7F;line-height:1.5">You'll be matched with an expert Quran tutor, In shaa Allah.</span>
            </td></tr>
          </table>
        </td>
        <td style="width:33.33%;padding:0 6px;vertical-align:top">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAF9;border-radius:12px;border:1px solid #E7F2EC">
            <tr><td style="padding:20px 16px;text-align:center">
              <span style="font-size:24px;display:block;margin-bottom:10px">🕌</span>
              <span style="font-size:13px;font-weight:700;color:#0C3B2E;display:block;margin-bottom:6px">Sadaqah Jariyah</span>
              <span style="font-size:12px;color:#6B8F7F;line-height:1.5">Learning & teaching the Quran is an ongoing reward.</span>
            </td></tr>
          </table>
        </td>
      </tr></table>
    </td></tr>` : `
    <!-- Retry CTA for failed -->
    <tr><td style="padding:20px 36px" align="center">
      <a href="${process.env.FRONTEND_URL}/fee" style="display:inline-block;padding:14px 40px;background:linear-gradient(135deg,#0C3B2E,#1B6B5A);color:#fff;font-size:14px;font-weight:600;text-decoration:none;border-radius:12px;box-shadow:0 4px 16px rgba(12,59,46,0.25)">Try Again</a>
    </td></tr>`}

    <!-- WhatsApp CTA -->
    <tr><td style="padding:8px 36px 16px" align="center">
      <a href="https://wa.me/16313558368" style="display:inline-block;padding:14px 40px;background:#25D366;color:#fff;font-size:14px;font-weight:600;text-decoration:none;border-radius:12px;box-shadow:0 4px 16px rgba(37,211,102,0.25)">Contact Us on WhatsApp</a>
    </td></tr>

    <!-- Closing -->
    <tr><td style="padding:16px 36px 32px" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:40px;height:1px;background:linear-gradient(90deg,transparent,#E7F2EC)"></td>
        <td style="padding:0 12px"><span style="color:#D4A843;font-size:10px">✦</span></td>
        <td style="width:40px;height:1px;background:linear-gradient(90deg,#E7F2EC,transparent)"></td>
      </tr></table>
      <p dir="rtl" style="margin:12px 0 0;font-family:'Amiri',serif;font-size:18px;color:#0C3B2E">
        بَارَكَ اللَّهُ فِيكُمْ
      </p>
      <p style="margin:4px 0 0;font-size:11px;color:#8AA89C;letter-spacing:0.5px;font-style:italic">
        May Allah bless you
      </p>
    </td></tr>`

  return {
    subject: `${isSuccess ? '✅' : '❌'} Barakallahu Feekum — ${isSuccess ? 'Payment Confirmed' : 'Payment Issue'}, ${firstName}`,
    html: userLayout(content),
  }
}

/* ═══════════════════════════════════════════════════════
   NEWSLETTER EMAIL (admin-composed, sent to subscribers)
   ═══════════════════════════════════════════════════════ */
export function newsletterEmail({ subject, body }) {
  // Convert newlines to paragraphs
  const paragraphs = body.split(/\n\n+/).map(p => p.trim()).filter(Boolean)
  const bodyHtml = paragraphs.map(p =>
    `<p style="margin:0 0 16px;font-size:15px;color:#1a1a1a;line-height:1.7">${p.replace(/\n/g, '<br>')}</p>`
  ).join('')

  const content = `
    <!-- Accent bar -->
    <tr><td style="height:4px;background:linear-gradient(90deg,#0C3B2E,#1B6B5A,#D4A843)"></td></tr>

    <!-- Arabic header -->
    <tr><td style="padding:36px 36px 0" align="center">
      <p dir="rtl" style="margin:0;font-family:'Amiri',serif;font-size:24px;color:#0C3B2E;line-height:1.4">
        ٱقْرَأْ بِٱسْمِ رَبِّكَ ٱلَّذِى خَلَقَ
      </p>
      <p style="margin:6px 0 0;font-size:10px;text-transform:uppercase;letter-spacing:2px;color:#8AA89C;font-weight:500">
        Read in the name of your Lord who created
      </p>
    </td></tr>

    <!-- Divider -->
    <tr><td style="padding:16px 36px 0" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:60px;height:1px;background:linear-gradient(90deg,transparent,#D4A843)"></td>
        <td style="padding:0 10px"><span style="color:#D4A843;font-size:12px">✦</span></td>
        <td style="width:60px;height:1px;background:linear-gradient(90deg,#D4A843,transparent)"></td>
      </tr></table>
    </td></tr>

    <!-- Subject heading -->
    <tr><td style="padding:24px 36px 4px" align="center">
      <h1 style="margin:0;font-size:26px;font-weight:700;color:#0C3B2E;letter-spacing:-0.3px;font-family:'Amiri',serif">
        ${subject}
      </h1>
    </td></tr>

    <!-- Body -->
    <tr><td style="padding:24px 36px 16px">
      ${bodyHtml}
    </td></tr>

    <!-- CTA -->
    <tr><td style="padding:8px 36px 16px" align="center">
      <a href="https://hidaya.online" style="display:inline-block;padding:14px 40px;background:linear-gradient(135deg,#0C3B2E,#1B6B5A);color:#fff;font-size:14px;font-weight:600;text-decoration:none;border-radius:12px;box-shadow:0 4px 16px rgba(12,59,46,0.25)">
        Visit Hidaya Online
      </a>
    </td></tr>

    <!-- Closing -->
    <tr><td style="padding:16px 36px 32px" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:40px;height:1px;background:linear-gradient(90deg,transparent,#E7F2EC)"></td>
        <td style="padding:0 12px"><span style="color:#D4A843;font-size:10px">✦</span></td>
        <td style="width:40px;height:1px;background:linear-gradient(90deg,#E7F2EC,transparent)"></td>
      </tr></table>
      <p dir="rtl" style="margin:12px 0 0;font-family:'Amiri',serif;font-size:18px;color:#0C3B2E">
        بَارَكَ اللَّهُ فِيكُمْ
      </p>
      <p style="margin:4px 0 0;font-size:11px;color:#8AA89C;letter-spacing:0.5px;font-style:italic">
        May Allah bless you
      </p>
      <p style="margin:16px 0 0;font-size:10px;color:#b0c4b8">
        <a href="${process.env.FRONTEND_URL || 'https://hidaya.online'}" style="color:#8AA89C;text-decoration:underline">Unsubscribe</a>
      </p>
    </td></tr>`

  return {
    subject,
    html: userLayout(content),
  }
}

/* ═══════════════════════════════════════════════════════
   USER — PAYMENT LINK EMAIL (sent to payee)
   ═══════════════════════════════════════════════════════ */
export function paymentLinkEmail(data) {
  const firstName = data.payeeName.split(' ')[0]
  const payUrl = `${process.env.FRONTEND_URL || 'https://hidaya.online'}/pay/${data.token}`

  const content = `
    <!-- Accent bar -->
    <tr><td style="height:4px;background:linear-gradient(90deg,#0C3B2E,#1B6B5A,#D4A843)"></td></tr>

    <!-- Arabic header -->
    <tr><td style="padding:36px 36px 0" align="center">
      <p dir="rtl" style="margin:0;font-family:'Amiri',serif;font-size:28px;color:#0C3B2E;line-height:1.4">
        ٱقْرَأْ بِٱسْمِ رَبِّكَ ٱلَّذِى خَلَقَ
      </p>
      <p style="margin:6px 0 0;font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#8AA89C;font-weight:500">
        Read in the name of your Lord who created &mdash; Al-Alaq 96:1
      </p>
    </td></tr>

    <!-- Divider -->
    <tr><td style="padding:20px 36px 0" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:80px;height:1px;background:linear-gradient(90deg,transparent,#D4A843)"></td>
        <td style="padding:0 10px"><span style="color:#D4A843;font-size:12px">✦</span></td>
        <td style="width:80px;height:1px;background:linear-gradient(90deg,#D4A843,transparent)"></td>
      </tr></table>
    </td></tr>

    <!-- Greeting -->
    <tr><td style="padding:24px 36px 0" align="center">
      <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:2.5px;color:#D4A843;font-weight:700">
        أهلاً وسهلاً
      </p>
      <p style="margin:4px 0 0;font-size:11px;color:#8AA89C;letter-spacing:0.5px;font-style:italic">Welcome</p>
      <h1 style="margin:10px 0 0;font-size:28px;font-weight:700;color:#0C3B2E;letter-spacing:-0.3px;font-family:'Amiri',serif">
        Payment Request, ${firstName}
      </h1>
      <p style="margin:12px 0 0;font-size:15px;color:#6B8F7F;line-height:1.6;max-width:420px">
        You have a pending payment from Hidaya Online. Please complete it at your earliest convenience.
      </p>
    </td></tr>

    <!-- Amount card -->
    <tr><td style="padding:28px 36px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#F8FAF9,#F0F7F4);border-radius:16px;border:1px solid #E7F2EC">
        <tr><td style="padding:28px" align="center">
          <span style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#8AA89C;font-weight:600;margin-bottom:8px">Amount Due</span>
          <span style="font-size:40px;font-weight:800;color:#0C3B2E;letter-spacing:-0.5px">${fmtCurrency(data.amount, data.currency)}</span>
          <span style="display:block;margin-top:8px;font-size:13px;color:#6B8F7F">${data.description}</span>
        </td></tr>
      </table>
    </td></tr>

    <!-- Details -->
    <tr><td style="padding:0 36px 8px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAF9;border-radius:14px;border:1px solid #E7F2EC">
        <tr><td style="padding:20px 24px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${row('Name', data.payeeName)}
            ${row('Email', data.payeeEmail)}
            ${row('Description', data.description)}
          </table>
        </td></tr>
      </table>
    </td></tr>

    <!-- Pay Now CTA -->
    <tr><td style="padding:24px 36px 16px" align="center">
      <a href="${payUrl}" style="display:inline-block;padding:16px 48px;background:linear-gradient(135deg,#0C3B2E,#1B6B5A);color:#fff;font-size:16px;font-weight:700;text-decoration:none;border-radius:14px;box-shadow:0 4px 20px rgba(12,59,46,0.3);letter-spacing:0.3px">
        Pay Now — ${fmtCurrency(data.amount, data.currency)}
      </a>
    </td></tr>

    <tr><td style="padding:0 36px 8px" align="center">
      <p style="margin:0;font-size:11px;color:#8AA89C">Secured by Mastercard Payment Gateway</p>
    </td></tr>

    <!-- WhatsApp CTA -->
    <tr><td style="padding:8px 36px 16px" align="center">
      <a href="https://wa.me/16313558368" style="display:inline-block;padding:12px 32px;background:#25D366;color:#fff;font-size:13px;font-weight:600;text-decoration:none;border-radius:12px;box-shadow:0 4px 16px rgba(37,211,102,0.25)">Questions? Contact Us</a>
    </td></tr>

    <!-- Closing -->
    <tr><td style="padding:16px 36px 32px" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:40px;height:1px;background:linear-gradient(90deg,transparent,#E7F2EC)"></td>
        <td style="padding:0 12px"><span style="color:#D4A843;font-size:10px">✦</span></td>
        <td style="width:40px;height:1px;background:linear-gradient(90deg,#E7F2EC,transparent)"></td>
      </tr></table>
      <p dir="rtl" style="margin:12px 0 0;font-family:'Amiri',serif;font-size:18px;color:#0C3B2E">
        بَارَكَ اللَّهُ فِيكُمْ
      </p>
      <p style="margin:4px 0 0;font-size:11px;color:#8AA89C;letter-spacing:0.5px;font-style:italic">
        May Allah bless you
      </p>
    </td></tr>`

  return {
    subject: `💳 Payment Request — ${fmtCurrency(data.amount, data.currency)} — Hidaya Online`,
    html: userLayout(content),
  }
}

/* ═══════════════════════════════════════════════════════
   ADMIN — PAYMENT LINK CREATED NOTIFICATION
   ═══════════════════════════════════════════════════════ */
export function paymentLinkAdminEmail(data) {
  const payUrl = `${process.env.FRONTEND_URL || 'https://hidaya.online'}/pay/${data.token}`

  const content = `
    <tr><td style="height:4px;background:linear-gradient(90deg,#0C3B2E,#1B6B5A,#D4A843)"></td></tr>
    <tr><td style="padding:32px 36px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td><span style="display:inline-block;padding:5px 14px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:0.5px;background:#E0F2FE;color:#0369A1;text-transform:uppercase">Payment Link</span></td>
        <td align="right"><span style="font-size:11px;color:#8AA89C;font-family:SFMono-Regular,Menlo,monospace">${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span></td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:20px 36px 4px">
      <h1 style="margin:0;font-size:24px;font-weight:700;color:#0C3B2E">Payment Link Sent</h1>
      <p style="margin:6px 0 0;font-size:14px;color:#6B8F7F">A payment link has been emailed to ${data.payeeName}.</p>
    </td></tr>
    <tr><td style="padding:24px 36px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0FDF9;border-radius:14px;border:1px solid #D1FAE5">
        <tr><td style="padding:24px 28px" align="center">
          <span style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#8AA89C;font-weight:600;margin-bottom:8px">Amount</span>
          <span style="font-size:36px;font-weight:800;color:#047857;letter-spacing:-0.5px">${fmtCurrency(data.amount, data.currency)}</span>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:0 36px"><div style="height:1px;background:linear-gradient(90deg,transparent,#e5e7eb,transparent)"></div></td></tr>
    <tr><td style="padding:8px 36px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${row('Payee', data.payeeName)}
        ${row('Email', data.payeeEmail, { link: `mailto:${data.payeeEmail}` })}
        ${data.payeePhone ? row('Phone', data.payeePhone) : ''}
        ${row('Description', data.description)}
        ${row('Link', payUrl, { mono: true, link: payUrl })}
      </table>
    </td></tr>`

  return {
    subject: `🔗 Payment Link Created — ${data.payeeName} (${fmtCurrency(data.amount, data.currency)})`,
    html: adminLayout(content),
  }
}

/* ═══════════════════════════════════════════════════════
   USER — INVOICE EMAIL (sent to payee after successful payment)
   ═══════════════════════════════════════════════════════ */
export function invoiceEmail({ link, payment }) {
  const firstName = link.payeeName.split(' ')[0]
  const invoiceNo = `INV-${payment.gatewayOrderId || payment._id.toString().slice(-8).toUpperCase()}`
  const paidDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  // Build items rows
  const items = (link.items || []).filter(i => i.trim())
  const itemsHtml = items.length > 0
    ? items.map((item, i) => `
        <tr>
          <td style="padding:10px 16px;border-bottom:1px solid #f0f4f2;font-size:13px;color:#0C3B2E">
            ${link.listType === 'numbered'
              ? `<span style="display:inline-block;width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#0C3B2E10,#1B6B5A10);text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#0C3B2E;margin-right:10px">${i + 1}</span>`
              : `<span style="color:#D4A843;margin-right:10px;font-size:10px">✦</span>`
            }${item}
          </td>
        </tr>`).join('')
    : ''

  const content = `
    <!-- Accent bar -->
    <tr><td style="height:4px;background:linear-gradient(90deg,#0C3B2E,#1B6B5A,#D4A843)"></td></tr>

    <!-- Arabic header -->
    <tr><td style="padding:36px 36px 0" align="center">
      <p dir="rtl" style="margin:0;font-family:'Amiri',serif;font-size:28px;color:#0C3B2E;line-height:1.4">
        ٱقْرَأْ بِٱسْمِ رَبِّكَ ٱلَّذِى خَلَقَ
      </p>
      <p style="margin:6px 0 0;font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#8AA89C;font-weight:500">
        Read in the name of your Lord who created &mdash; Al-Alaq 96:1
      </p>
    </td></tr>

    <!-- Divider -->
    <tr><td style="padding:20px 36px 0" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:80px;height:1px;background:linear-gradient(90deg,transparent,#D4A843)"></td>
        <td style="padding:0 10px"><span style="color:#D4A843;font-size:12px">✦</span></td>
        <td style="width:80px;height:1px;background:linear-gradient(90deg,#D4A843,transparent)"></td>
      </tr></table>
    </td></tr>

    <!-- Invoice header -->
    <tr><td style="padding:24px 36px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td>
          <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:2.5px;color:#D4A843;font-weight:700">Invoice</p>
          <h1 style="margin:6px 0 0;font-size:28px;font-weight:700;color:#0C3B2E;font-family:'Amiri',serif">
            Payment Receipt
          </h1>
        </td>
        <td align="right" style="vertical-align:top">
          <span style="display:inline-block;padding:6px 16px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:0.5px;background:#D1FAE5;color:#047857;text-transform:uppercase">✓ Paid</span>
        </td>
      </tr></table>
    </td></tr>

    <!-- Invoice meta -->
    <tr><td style="padding:16px 36px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAF9;border-radius:12px;border:1px solid #E7F2EC">
        <tr>
          <td style="padding:16px 20px;border-right:1px solid #E7F2EC" align="center">
            <span style="display:block;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#8AA89C;font-weight:600">Invoice No.</span>
            <span style="display:block;margin-top:4px;font-family:SFMono-Regular,Menlo,monospace;font-size:12px;color:#0C3B2E;font-weight:600">${invoiceNo}</span>
          </td>
          <td style="padding:16px 20px;border-right:1px solid #E7F2EC" align="center">
            <span style="display:block;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#8AA89C;font-weight:600">Date</span>
            <span style="display:block;margin-top:4px;font-size:12px;color:#0C3B2E;font-weight:600">${paidDate}</span>
          </td>
          <td style="padding:16px 20px" align="center">
            <span style="display:block;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#8AA89C;font-weight:600">Method</span>
            <span style="display:block;margin-top:4px;font-size:12px;color:#0C3B2E;font-weight:600">Mastercard</span>
          </td>
        </tr>
      </table>
    </td></tr>

    <!-- Bill To -->
    <tr><td style="padding:24px 36px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:top;width:50%">
          <span style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#8AA89C;font-weight:600">Bill To</span>
          <p style="margin:8px 0 0;font-size:15px;font-weight:700;color:#0C3B2E">${link.payeeName}</p>
          <p style="margin:4px 0 0;font-size:13px;color:#6B8F7F">${link.payeeEmail}</p>
          ${link.payeePhone ? `<p style="margin:2px 0 0;font-size:13px;color:#6B8F7F">${link.payeePhone}</p>` : ''}
        </td>
        <td style="vertical-align:top;width:50%" align="right">
          <span style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#8AA89C;font-weight:600">From</span>
          <p style="margin:8px 0 0;font-size:15px;font-weight:700;color:#0C3B2E">Hidaya Online</p>
          <p style="margin:4px 0 0;font-size:13px;color:#6B8F7F">hidaya.online</p>
        </td>
      </tr></table>
    </td></tr>

    <!-- Description + Items -->
    <tr><td style="padding:24px 36px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:12px;overflow:hidden;border:1px solid #E7F2EC">
        <!-- Table header -->
        <tr>
          <td style="padding:12px 16px;background:#F8FAF9;border-bottom:2px solid #E7F2EC">
            <span style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#8AA89C;font-weight:700">Description</span>
          </td>
        </tr>
        <!-- Main description -->
        <tr>
          <td style="padding:14px 16px;border-bottom:1px solid #f0f4f2;font-size:14px;font-weight:600;color:#0C3B2E">${link.description}</td>
        </tr>
        ${itemsHtml}
      </table>
    </td></tr>

    <!-- Amount summary -->
    <tr><td style="padding:20px 36px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${payment.discountAmount > 0 ? `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #E7F2EC">
            <span style="font-size:13px;color:#6B8F7F">Original Amount</span>
          </td>
          <td style="padding:12px 0;border-bottom:1px solid #E7F2EC;text-align:right">
            <span style="font-size:14px;color:#0C3B2E;font-weight:500">${fmtCurrency(payment.originalAmount, link.currency)}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #E7F2EC">
            <span style="font-size:13px;color:#059669">Discount <span style="font-family:SFMono-Regular,Menlo,monospace;font-size:11px;background:#D1FAE5;padding:2px 7px;border-radius:4px">${payment.discountCode}</span></span>
          </td>
          <td style="padding:12px 0;border-bottom:1px solid #E7F2EC;text-align:right">
            <span style="font-size:14px;color:#059669;font-weight:600">-${fmtCurrency(payment.discountAmount, link.currency)}</span>
          </td>
        </tr>` : `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #E7F2EC">
            <span style="font-size:13px;color:#6B8F7F">Subtotal</span>
          </td>
          <td style="padding:12px 0;border-bottom:1px solid #E7F2EC;text-align:right">
            <span style="font-size:14px;color:#0C3B2E;font-weight:500">${fmtCurrency(link.amount, link.currency)}</span>
          </td>
        </tr>`}
        <tr>
          <td style="padding:14px 0">
            <span style="font-size:15px;font-weight:700;color:#0C3B2E">Total Paid</span>
          </td>
          <td style="padding:14px 0;text-align:right">
            <span style="font-size:24px;font-weight:800;color:#047857;letter-spacing:-0.3px">${fmtCurrency(payment.amount, link.currency)}</span>
          </td>
        </tr>
      </table>
    </td></tr>

    <!-- Transaction details -->
    <tr><td style="padding:0 36px 8px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0FDF9;border-radius:12px;border:1px solid #D1FAE5">
        <tr><td style="padding:16px 20px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:4px 0"><span style="font-size:11px;color:#6B8F7F">Order ID</span></td>
              <td style="padding:4px 0;text-align:right"><span style="font-family:SFMono-Regular,Menlo,monospace;font-size:11px;color:#047857">${payment.gatewayOrderId || '—'}</span></td>
            </tr>
            ${payment.gatewayTransactionId ? `<tr>
              <td style="padding:4px 0"><span style="font-size:11px;color:#6B8F7F">Transaction ID</span></td>
              <td style="padding:4px 0;text-align:right"><span style="font-family:SFMono-Regular,Menlo,monospace;font-size:11px;color:#047857">${payment.gatewayTransactionId}</span></td>
            </tr>` : ''}
            <tr>
              <td style="padding:4px 0"><span style="font-size:11px;color:#6B8F7F">Currency</span></td>
              <td style="padding:4px 0;text-align:right"><span style="font-size:11px;color:#047857;font-weight:600">${link.currency || 'PKR'}</span></td>
            </tr>
          </table>
        </td></tr>
      </table>
    </td></tr>

    <!-- WhatsApp CTA -->
    <tr><td style="padding:16px 36px 16px" align="center">
      <a href="https://wa.me/16313558368" style="display:inline-block;padding:12px 32px;background:#25D366;color:#fff;font-size:13px;font-weight:600;text-decoration:none;border-radius:12px;box-shadow:0 4px 16px rgba(37,211,102,0.25)">Questions? Contact Us</a>
    </td></tr>

    <!-- Closing -->
    <tr><td style="padding:16px 36px 32px" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:40px;height:1px;background:linear-gradient(90deg,transparent,#E7F2EC)"></td>
        <td style="padding:0 12px"><span style="color:#D4A843;font-size:10px">✦</span></td>
        <td style="width:40px;height:1px;background:linear-gradient(90deg,#E7F2EC,transparent)"></td>
      </tr></table>
      <p dir="rtl" style="margin:12px 0 0;font-family:'Amiri',serif;font-size:18px;color:#0C3B2E">
        جَزَاكَ اللَّهُ خَيْرًا
      </p>
      <p style="margin:4px 0 0;font-size:11px;color:#8AA89C;letter-spacing:0.5px;font-style:italic">
        May Allah reward you with goodness
      </p>
    </td></tr>`

  return {
    subject: `🧾 Invoice — ${fmtCurrency(payment.amount, link.currency)} — Hidaya Online (${invoiceNo})`,
    html: userLayout(content),
  }
}
