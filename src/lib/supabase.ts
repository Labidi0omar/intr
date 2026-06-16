import { createClient } from '@supabase/supabase-js'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Platform } from 'react-native'

const SUPABASE_URL = 'https://ehbbpawgntvykkiioukl.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVoYmJwYXdnbnR2eWtraWlvdWtsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMjI0NDAsImV4cCI6MjA4OTY5ODQ0MH0.ZlIu0_gKk1ljKUP_8_xxuzGj5uvRZk5eBdRXDC7iYWs'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: Platform.OS === 'web' ? undefined : AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  }
})
