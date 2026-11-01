// خطأ رسالته آمنة نعرضها للمستخدم في واتساب
class UserError extends Error {
  constructor(message) { super(message); this.safe = true; }
}
module.exports = { UserError };
