import nodemailer from 'nodemailer'

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
      from: `"Hidaya Online Academy" <${process.env.SMTP_USER}>`,
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
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr>
              <td style="width:40px;height:40px;background:linear-gradient(135deg,#1B6B5A,#D4A843);border-radius:12px;text-align:center;vertical-align:middle">
                <span style="color:#fff;font-size:18px;font-weight:700;line-height:40px">H</span>
              </td>
              <td style="padding-left:12px">
                <span style="font-size:20px;font-weight:700;color:#0C3B2E;letter-spacing:-0.3px">Hidaya</span>
                <span style="font-size:20px;font-weight:400;color:#6B8F7F;letter-spacing:-0.3px"> Online</span>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(12,59,46,0.06),0 8px 24px -8px rgba(12,59,46,0.08)">
            ${content}
          </table>
        </td></tr>
        <tr><td style="padding:32px 0 0" align="center">
          <span style="display:inline-block;width:32px;height:2px;background:linear-gradient(90deg,#D4A843,#1B6B5A);border-radius:1px"></span>
          <p style="color:#8AA89C;font-size:11px;line-height:18px;letter-spacing:0.3px;margin:12px 0 0">
            Hidaya Online Academy &middot; Rawalpindi, Pakistan<br>
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
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr>
              <td style="width:44px;height:44px;background:linear-gradient(135deg,#0C3B2E,#1B6B5A);border-radius:14px;text-align:center;vertical-align:middle">
                <span style="color:#D4A843;font-size:20px;font-weight:700;line-height:44px;font-family:'Amiri',serif">ه</span>
              </td>
              <td style="padding-left:12px">
                <span style="font-size:22px;font-weight:700;color:#0C3B2E;letter-spacing:-0.3px;font-family:'Amiri',serif">Hidaya</span>
                <span style="font-size:22px;font-weight:400;color:#6B8F7F;letter-spacing:-0.3px;font-family:'Amiri',serif"> Online</span>
              </td>
            </tr>
          </table>
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
            Hidaya Online Academy<br>
            D-804 5th Road, Satellite Town, Rawalpindi, Pakistan
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
          <span style="font-size:36px;font-weight:800;color:${statusColor};letter-spacing:-0.5px">Rs. ${Number(data.amount).toLocaleString()}</span>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:0 36px"><div style="height:1px;background:linear-gradient(90deg,transparent,#e5e7eb,transparent)"></div></td></tr>
    <tr><td style="padding:8px 36px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${row('Student', data.studentName)}
        ${row('Email', data.studentEmail, { link: `mailto:${data.studentEmail}` })}
        ${row('Plan', data.plan)}
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
    subject: `${isSuccess ? '✅' : '❌'} Payment ${data.status} — ${data.studentName} (Rs. ${Number(data.amount).toLocaleString()})`,
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
          <span style="font-size:40px;font-weight:800;color:${statusColor};letter-spacing:-0.5px">Rs. ${Number(data.amount).toLocaleString()}</span>
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
              <td style="padding:8px 0;border-bottom:1px solid #E7F2EC"><span style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8AA89C;font-weight:600">Student</span></td>
              <td style="padding:8px 0;border-bottom:1px solid #E7F2EC;text-align:right"><span style="font-size:14px;color:#0C3B2E;font-weight:600">${data.studentName}</span></td>
            </tr>
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
