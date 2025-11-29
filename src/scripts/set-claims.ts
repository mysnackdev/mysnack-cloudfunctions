import { authAdmin } from "../shared/admin.js";
const [,, uid, role = "store-operator", storeId = "", shoppingId = ""] = process.argv;
async function run() {
  await authAdmin.setCustomUserClaims(uid, { role, storeId, shoppingId });
  console.log("Claims set", { uid, role, storeId, shoppingId });
}
run();
