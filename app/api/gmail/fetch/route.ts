import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import { supabaseAdmin } from '@/lib/supabase';
import { withAuth } from '@/lib/global-auth';
import { getServerSession } from 'next-auth';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

// Create Supabase admin client
function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing required environment variables: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return null;
  }
  
  return createClient(supabaseUrl, supabaseKey);
}

// Helper function to get user from NextAuth session
async function getUserFromSession() {
  try {
    const session = await getServerSession();
    return session?.user || null;
  } catch (error) {
    console.error('Error getting user from session:', error);
    return null;
  }
}

// Function to get a refreshed access token if needed
async function getRefreshedToken(userId: string): Promise<string | null> {
  try {
    const { data: integration, error } = await supabaseAdmin
      .from('integrations')
      .select('refresh_token, expires_at')
      .eq('user_id', userId)
      .eq('service_name', 'google-gmail') // Ensure we get the Gmail token
      .single();

    if (error || !integration?.refresh_token) {
      console.error('No Google integration or refresh token found for user:', userId, error);
      return null;
    }

    // Check if token is expired or close to expiring (e.g., within 5 minutes)
    const expiryDate = integration.expires_at ? new Date(integration.expires_at) : new Date();
    if (expiryDate > new Date(Date.now() + 5 * 60 * 1000)) {
       // Token is still valid, no need to refresh immediately in this check, 
       // but the API call might still fail if it just expired.
       // We rely on the main API call to handle potential 401 and trigger refresh then.
       console.log('[API/Gmail] Token potentially valid, proceeding with existing token.');
       return null; // Indicate no refresh needed *right now*
    }

    console.log('[API/Gmail] Refreshing Google token for user:', userId);
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials({ refresh_token: integration.refresh_token });

    const { credentials } = await oauth2Client.refreshAccessToken();
    
    if (!credentials.access_token) {
        throw new Error('Failed to refresh access token');
    }

    // Update the database with the new token and expiry
    const newExpiresAt = credentials.expiry_date ? new Date(credentials.expiry_date) : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000); // 2 months
    const { error: updateError } = await supabaseAdmin
        .from('integrations')
        .update({ 
            access_token: credentials.access_token,
            expires_at: newExpiresAt.toISOString(),
            updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('service_name', 'google-gmail');

    if (updateError) {
        console.error('[API/Gmail] Failed to update new token in DB:', updateError);
        // Continue with the new token anyway, but log the error
    }

    console.log('[API/Gmail] Token refreshed successfully for user:', userId);
    return credentials.access_token;

  } catch (error) {
    console.error('[API/Gmail] Error refreshing token:', error);
    return null;
  }
}

export async function GET(req: NextRequest) {
  try {
    // Get user from NextAuth session
    const user = await getUserFromSession();
    if (!user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const searchParams = req.nextUrl.searchParams;
    const searchQuery = searchParams.get('q') || '';
    
    // Check if the user has Gmail integration
    const { data: integration, error: integrationError } = await supabaseAdmin
      .from('integrations')
      .select('access_token, refresh_token')
      .eq('user_id', user.id)
      .eq('service_name', 'google-gmail')
      .maybeSingle();

    if (integrationError || !integration) {
      console.log('No Gmail integration found for user');
      return NextResponse.json({ 
        error: 'Gmail integration not found', 
        setupRequired: true 
      }, { status: 401 });
    }

    // Get or refresh the access token
    let accessToken = integration.access_token;
    
    // If integration exists but we need a fresh token, get it
    if (!accessToken || !integration.access_token) {
      const refreshedToken = await getRefreshedToken(user.id);
      if (!refreshedToken) {
        return NextResponse.json({ 
          error: 'Failed to refresh access token', 
          code: 'AUTH_FAILED_AFTER_REFRESH' 
        }, { status: 401 });
      }
      accessToken = refreshedToken;
    }
    
    // Create an OAuth2 client with the token
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials({ access_token: accessToken });
    
    // Create the Gmail API client
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    
    // Set up query parameters for the Gmail API
    const queryParams: any = {
      userId: 'me',
      maxResults: 20, // Adjust as needed
    };
    
    // Add search query if provided
    if (searchQuery) {
      queryParams.q = searchQuery;
    }
    
    try {
      // Call the Gmail API to list messages
      const response = await gmail.users.messages.list(queryParams);
      
      // If no messages are found, return empty array
      if (!response.data.messages || response.data.messages.length === 0) {
    return NextResponse.json({
      emails: [],
          nextPageToken: null
        });
      }
      
      // Fetch details for each message (in parallel for performance)
      const messagePromises = response.data.messages.map(async (message: any) => {
        const msgResponse = await gmail.users.messages.get({
          userId: 'me',
          id: message.id,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date']
        });
        
        return msgResponse.data;
      });
      
      const messageDetails = await Promise.all(messagePromises);
      
      // Format the emails for the frontend
      const emails = messageDetails.map((message: any) => {
        // Extract headers
        const headers = message.payload.headers;
        const fromHeader = headers.find((h: any) => h.name === 'From');
        const subjectHeader = headers.find((h: any) => h.name === 'Subject');
        const dateHeader = headers.find((h: any) => h.name === 'Date');
        
        // Parse the 'From' field to extract email and name
        const fromText = fromHeader ? fromHeader.value : 'Unknown';
        const emailMatch = fromText.match(/<(.+)>/);
        const fromEmail = emailMatch ? emailMatch[1] : fromText;
        
        return {
          id: message.id,
          threadId: message.threadId,
          snippet: message.snippet,
          from: fromText,
          from_email: fromEmail,
          subject: subjectHeader ? subjectHeader.value : 'No Subject',
          date: dateHeader ? dateHeader.value : new Date().toISOString(),
          unread: message.labelIds?.includes('UNREAD') || false
        };
      });
      
      return NextResponse.json({
        emails,
        nextPageToken: response.data.nextPageToken || null
      });
    } catch (apiError: any) {
      console.error('Gmail API error:', apiError);
      
      // Handle token expiration errors
      if (apiError.code === 401 || 
          (apiError.response && apiError.response.status === 401)) {
        console.log('[API/Gmail] 401 error detected, attempting token refresh and retry');
        
        // Try to refresh the token
        const refreshedToken = await getRefreshedToken(user.id);
        
        if (!refreshedToken) {
          return NextResponse.json({ 
            error: 'Authentication failed after token refresh', 
            code: 'AUTH_FAILED_AFTER_REFRESH' 
          }, { status: 401 });
        }
        
        try {
          console.log('[API/Gmail] Retrying Gmail API call with refreshed token');
          
          // Retry the Gmail API call with the new token
          const retryOauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET
          );
          retryOauth2Client.setCredentials({ access_token: refreshedToken });
          
          const retryGmail = google.gmail({ version: 'v1', auth: retryOauth2Client });
          
          // Retry the Gmail API call
          const retryResponse = await retryGmail.users.messages.list(queryParams);
          
          // If no messages are found, return empty array
          if (!retryResponse.data.messages || retryResponse.data.messages.length === 0) {
            return NextResponse.json({
              emails: [],
              nextPageToken: null
            });
          }
          
          // Fetch details for each message (in parallel for performance)
          const retryMessagePromises = retryResponse.data.messages.map(async (message: any) => {
            const msgResponse = await retryGmail.users.messages.get({
              userId: 'me',
              id: message.id,
              format: 'metadata',
              metadataHeaders: ['From', 'Subject', 'Date']
            });
            
            return msgResponse.data;
          });
          
          const retryMessageDetails = await Promise.all(retryMessagePromises);
          
          // Format the emails for the frontend
          const retryEmails = retryMessageDetails.map((message: any) => {
            // Extract headers
            const headers = message.payload.headers;
            const fromHeader = headers.find((h: any) => h.name === 'From');
            const subjectHeader = headers.find((h: any) => h.name === 'Subject');
            const dateHeader = headers.find((h: any) => h.name === 'Date');
            
            // Parse the 'From' field to extract email and name
            const fromText = fromHeader ? fromHeader.value : 'Unknown';
            const emailMatch = fromText.match(/<(.+)>/);
            const fromEmail = emailMatch ? emailMatch[1] : fromText;
            
            return {
              id: message.id,
              threadId: message.threadId,
              snippet: message.snippet,
              from: fromText,
              from_email: fromEmail,
              subject: subjectHeader ? subjectHeader.value : 'No Subject',
              date: dateHeader ? dateHeader.value : new Date().toISOString(),
              unread: message.labelIds?.includes('UNREAD') || false
            };
          });
          
          console.log('[API/Gmail] Successfully retried after token refresh');
          return NextResponse.json({
            emails: retryEmails,
            nextPageToken: retryResponse.data.nextPageToken || null
          });
          
        } catch (retryError: any) {
          console.error('[API/Gmail] Retry failed after token refresh:', retryError);
          return NextResponse.json({ 
            error: 'Authentication failed even after token refresh', 
            code: 'AUTH_FAILED_AFTER_REFRESH'
          }, { status: 401 });
        }
      }
      
      // Handle other specific errors
      if (apiError.message?.includes('insufficient permission')) {
        return NextResponse.json({ 
          error: 'Insufficient permissions to access Gmail', 
          code: 'PERMISSION_DENIED' 
        }, { status: 403 });
      }
      
      // General error
      return NextResponse.json({ 
        error: 'Failed to fetch emails from Gmail API: ' + (apiError.message || 'Unknown error'), 
        code: 'API_ERROR'
      }, { status: 500 });
    }
  } catch (error) {
    console.error('Error fetching emails from Gmail:', error);
    return NextResponse.json({ error: 'Failed to fetch emails' }, { status: 500 });
  }
} 