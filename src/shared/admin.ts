import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";
const app = initializeApp();

const DEFAULT_DATABASE_ID = "db-my-snack";
const envDatabaseId = process.env.FIRESTORE_DB_ID?.trim();

export const FIRESTORE_DATABASE_ID =
  envDatabaseId && envDatabaseId.length > 0 ? envDatabaseId : DEFAULT_DATABASE_ID;

const firestore = getFirestore(app, FIRESTORE_DATABASE_ID);

firestore.settings({ ignoreUndefinedProperties: true });

export const db = firestore;
export const authAdmin = getAuth(app);
export const rtdb = getDatabase(app);
