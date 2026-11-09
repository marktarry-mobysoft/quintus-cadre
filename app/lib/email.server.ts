export type Email = {
  to: string;
  subject: string;
  body: string;
};

/**
 * There is no mail transport wired up yet, so the built message goes to the
 * server log.
 */
export function sendEmail(email: Email) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}
