// firebase functions/index.tsx
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import * as admin from "firebase-admin";
import axios from "axios";

// Initialize Firebase Admin
admin.initializeApp();
const db = admin.firestore();


// nRF Cloud configuration
const NRF_CLOUD_BASE_URL = 'https://api.nrfcloud.com/v1';
const NRF_CLOUD_API_KEY = `${process.env.NRF_CLOUD_API_KEY}`; // Replace with your actual API key
const DEVICE_ID = `${process.env.LAR91_DEVICE_ID}`;


// FCM Topic for device alerts - users can subscribe to this topic
const FCM_ALERT_TOPIC = `device_${DEVICE_ID}_movement_alerts`;


// Type definitions
interface MovementAlert {
  id?: string;
  deviceId: string;
  alertType: string;
  distance: number;
  threshold: number;
  lockedLocation: {
    lat: number;
    lon: number;
  };
  currentLocation: {
    lat: number;
    lon: number;
  };
  lockedAt: string;
  detectedAt: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
  timestamp?: admin.firestore.FieldValue;
  source: string;
  notificationSent?: boolean;
  notificationSentAt?: admin.firestore.FieldValue;
}


interface TokenData {
  deviceId: string;
  pushToken: string;
  tokenType: 'expo' | 'fcm';
  userId: string;
  platform: string;
  registeredAt: admin.firestore.FieldValue;
  lastUsed: admin.firestore.FieldValue;
  active: boolean;
}

// Helper function to calculate distance between two coordinates
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; 
}

// NEW: Function to control LED via nRF Cloud API
async function controlNRFCloudLED(deviceId: string, ledConfig: any): Promise<boolean> {
  try {
    const response = await axios.patch(
      `${NRF_CLOUD_BASE_URL}/devices/${deviceId}/state`,
      {
        desired: {
          update_interval: 60,
          led: ledConfig
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${NRF_CLOUD_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    logger.info('Successfully sent LED control to nRF Cloud', {
      deviceId,
      ledConfig,
      response: response.status
    });

    return true;
  } catch (error: any) {
    logger.error('Error controlling LED via nRF Cloud:', error);
    return false;
  }
}

// NEW: Function to turn on LED alert (simplified - always cyan)
async function turnOnMovementAlertLED(deviceId: string): Promise<void> {
  try {
    const ledConfig = {
      red: 0,
      green: 0,
      blue: 255,
      duration_on_msec: 500,
      duration_off_msec: 1000,
      repetitions: 5
    };

    await controlNRFCloudLED(deviceId, ledConfig);
    
    // Schedule LED turn off after 60 seconds
    setTimeout(async () => {
      await turnOffLED(deviceId);
    }, 60000);

  } catch (error: any) {
    logger.error('Error turning on movement alert LED:', error);
  }
}

// NEW: Function to turn off LED
async function turnOffLED(deviceId: string): Promise<void> {
  try {
    const ledOffConfig = {
      red: 0,
      green: 0,
      blue: 0,
      duration_on_msec: 0,
      duration_off_msec: 0,
      repetitions: 0
    };

    await controlNRFCloudLED(deviceId, ledOffConfig);
    logger.info('LED turned off after 60 seconds', { deviceId });

  } catch (error: any) {
    logger.error('Error turning off LED:', error);
  }
}

async function sendFCMNotification(movementAlert: MovementAlert): Promise<boolean> {
  try {
    const message = {
      notification: {
        title: '⚠️ Device Movement Alert',
        body: `Your LAR91X device has moved ${movementAlert.distance.toFixed(1)}m away from the locked location!`,
      },
      data: {
        alertType: 'movement_detected',
        deviceId: movementAlert.deviceId,
        distance: movementAlert.distance.toString(),
        severity: movementAlert.severity,
        timestamp: movementAlert.detectedAt,
        lockedLat: movementAlert.lockedLocation.lat.toString(),
        lockedLon: movementAlert.lockedLocation.lon.toString(),
        currentLat: movementAlert.currentLocation.lat.toString(),
        currentLon: movementAlert.currentLocation.lon.toString(),
      },
      android: {
        notification: {
          icon: 'ic_notification',
          color: '#ff5252',
          sound: 'default',
          priority: 'high' as const,
          channelId: 'movement_alerts'
        },
        priority: 'high' as const
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: '⚠️ Device Movement Alert',
              body: `Your LAR91X device has moved ${movementAlert.distance.toFixed(1)}m away from the locked location!`
            },
            sound: 'default',
            badge: 1
          }
        }
      },
      topic: FCM_ALERT_TOPIC
    };


    const response = await admin.messaging().send(message);
   
    logger.info('Successfully sent FCM notification', {
      messageId: response,
      deviceId: movementAlert.deviceId,
      distance: movementAlert.distance.toFixed(1) + 'm'
    });


    return true;


  } catch (error: any) {
    logger.error('Error sending FCM notification:', error);
    return false;
  }
}


// Function to send notifications to specific user tokens (FCM)
async function sendFCMNotificationsToUsers(movementAlert: MovementAlert, userTokens: string[]): Promise<void> {
  if (!userTokens || userTokens.length === 0) {
    logger.info('No FCM user tokens available for notification');
    return;
  }


  try {
    const message = {
      notification: {
        title: '⚠️ LAR91X Movement Alert',
        body: `Device has moved ${movementAlert.distance.toFixed(1)}m from locked position!`,
      },
      data: {
        alertType: 'movement_detected',
        deviceId: movementAlert.deviceId,
        distance: movementAlert.distance.toString(),
        severity: movementAlert.severity,
        timestamp: movementAlert.detectedAt,
        clickAction: 'OPEN_DEVICE_LOCATION'
      },
      android: {
        notification: {
          icon: 'ic_notification',
          color: '#ff5252',
          sound: 'default',
          priority: 'high' as const,
          channelId: 'movement_alerts'
        }
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: '⚠️ LAR91X Movement Alert',
              body: `Device has moved ${movementAlert.distance.toFixed(1)}m from locked position!`
            },
            sound: 'default',
            badge: 1
          }
        }
      },
      tokens: userTokens
    };


    const response = await admin.messaging().sendEachForMulticast(message);
   
    logger.info('FCM multicast sent', {
      successCount: response.successCount,
      failureCount: response.failureCount,
      deviceId: movementAlert.deviceId
    });


    // Log failed tokens for cleanup
    if (response.failureCount > 0) {
      const failedTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          failedTokens.push(userTokens[idx]);
          logger.warn('Failed to send to FCM token', {
            token: userTokens[idx],
            error: resp.error?.message
          });
        }
      });
     
      // Store failed tokens for potential cleanup
      await db.collection('failed_tokens').add({
        deviceId: movementAlert.deviceId,
        failedTokens: failedTokens,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    }


  } catch (error: any) {
    logger.error('Error sending multicast FCM notification:', error);
  }
}


// Updated movement alert notification function to handle both FCM and Expo
async function sendMovementAlertNotification(movementAlert: MovementAlert): Promise<boolean> {
  try {
    let fcmSuccess = false;
    let expoSuccess = false;

    // Trigger LED alert via nRF Cloud API instead of MQTT
    await turnOnMovementAlertLED(movementAlert.deviceId);

    // Get all registered tokens for this device
    const tokenSnapshot = await db.collection('user_push_tokens')
      .where('deviceId', '==', movementAlert.deviceId)
      .where('active', '==', true)
      .get();
   
    if (tokenSnapshot.empty) {
      logger.info('No push tokens registered for device', { deviceId: movementAlert.deviceId });
     
      // Send topic-based FCM notification as fallback
      try {
        await sendFCMNotification(movementAlert);
        logger.info('Sent fallback FCM topic notification');
      } catch (error: any) {
        logger.error('Error sending fallback FCM notification:', error);
      }
     
      return false;
    }


    const fcmTokens: string[] = [];
    const expoTokens: string[] = [];


    // Separate FCM and Expo tokens
    tokenSnapshot.docs.forEach(doc => {
      const data = doc.data() as TokenData;
      if (data.tokenType === 'expo') {
        expoTokens.push(data.pushToken);
      } else {
        fcmTokens.push(data.pushToken);
      }
    });


    // Send FCM notifications
    if (fcmTokens.length > 0) {
      try {
        await sendFCMNotificationsToUsers(movementAlert, fcmTokens);
        fcmSuccess = true;
        logger.info(`Sent FCM notifications to ${fcmTokens.length} tokens`);
      } catch (error: any) {
        logger.error('Error sending FCM notifications:', error);
      }
    }


    // // Send Expo notifications
    // if (expoTokens.length > 0) {
    //   try {
    //     await sendExpoNotificationsToUsers(movementAlert, expoTokens);
    //     expoSuccess = true;
    //     logger.info(`Sent Expo notifications to ${expoTokens.length} tokens`);
    //   } catch (error: any) {
    //     logger.error('Error sending Expo notifications:', error);
    //   }
    // }


    // Send topic-based FCM notification as additional coverage
    try {
      await sendFCMNotification(movementAlert);
      logger.info('Sent additional FCM topic notification');
    } catch (error: any) {
      logger.error('Error sending additional FCM topic notification:', error);
    }


    const success = fcmSuccess || expoSuccess;
   
    // Store notification summary
    await db.collection('notification_summary').add({
      deviceId: movementAlert.deviceId,
      alertType: 'movement_detected',
      fcmTokenCount: fcmTokens.length,
      expoTokenCount: expoTokens.length,
      fcmSuccess: fcmSuccess,
      expoSuccess: expoSuccess,
      overallSuccess: success,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      alertData: movementAlert
    });


    return success;


  } catch (error: any) {
    logger.error('Error in sendMovementAlertNotification:', error);
    return false;
  }
}

export const postLockedLocation = onRequest({
  cors: true
}, async (request, response) => {
  try {
    const { deviceId, lockedAt, location, originalLocationData, status, timestamp } = request.body;


    // Validate required fields
    if (!deviceId || !location || !location.lat || !location.lon) {
      response.status(400).json({
        success: false,
        error: 'Missing required fields: deviceId, location.lat, location.lon'
      });
      return;
    }


    // Create locked location document
    const lockedLocationData = {
      deviceId: deviceId,
      lockedAt: lockedAt || new Date().toISOString(),
      location: {
        lat: parseFloat(location.lat),
        lon: parseFloat(location.lon),
        uncertainty: location.uncertainty || null,
        serviceType: location.serviceType || null
      },
      originalLocationData: originalLocationData || null,
      status: status || 'locked',
      timestamp: timestamp || new Date().toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };


    // Store the locked location using deviceId as document ID to ensure uniqueness
    await db.collection('locked_locations').doc(deviceId).set(lockedLocationData);


    // Also log in history
    await db.collection('location_lock_history').add({
      ...lockedLocationData,
      action: 'lock'
    });


    logger.info('Successfully stored locked location', { deviceId, location });


    response.json({
      success: true,
      message: 'Location locked successfully',
      deviceId: deviceId,
      location: location,
      documentId: deviceId
    });
    return;


  } catch (error: any) {
    logger.error('Error storing locked location:', error);
   
    response.status(500).json({
      success: false,
      error: 'Failed to store locked location',
      details: error.message
    });
    return;
  }
});


// Function to clear locked location from Firebase
export const clearLockedLocation = onRequest({
  cors: true
}, async (request, response) => {
  try {
    const { deviceId, unlockedAt, status, timestamp } = request.body;


    // Validate required fields
    if (!deviceId) {
      response.status(400).json({
        success: false,
        error: 'Missing required field: deviceId'
      });
      return;
    }


    // Get the existing locked location before deleting
    const lockedLocationDoc = await db.collection('locked_locations').doc(deviceId).get();
   
    if (!lockedLocationDoc.exists) {
      response.status(404).json({
        success: false,
        error: 'No locked location found for this device'
      });
      return;
    }


    const existingData = lockedLocationDoc.data();


    // Create unlock record
    const unlockData = {
      deviceId: deviceId,
      unlockedAt: unlockedAt || new Date().toISOString(),
      status: status || 'unlocked',
      timestamp: timestamp || new Date().toISOString(),
      previousLockData: existingData,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };


    // Delete the locked location document
    await db.collection('locked_locations').doc(deviceId).delete();


    // Log the unlock action in history
    await db.collection('location_lock_history').add({
      ...unlockData,
      action: 'unlock'
    });


    logger.info('Successfully cleared locked location', { deviceId });


    response.json({
      success: true,
      message: 'Location unlocked successfully',
      deviceId: deviceId,
      unlockedAt: unlockedAt || new Date().toISOString()
    });
    return;


  } catch (error: any) {
    logger.error('Error clearing locked location:', error);
   
    response.status(500).json({
      success: false,
      error: 'Failed to clear locked location',
      details: error.message
    });
    return;
  }
});


// Updated registerFCMToken function to handle both FCM and Expo tokens
export const registerFCMToken = onRequest({
  cors: true
}, async (request, response) => {
  try {
    const { deviceId, fcmToken, userId, platform, tokenType } = request.body;


    if (!deviceId || !fcmToken) {
      response.status(400).json({
        success: false,
        error: 'Missing required fields: deviceId, fcmToken'
      });
      return;
    }


    const isExpoToken = tokenType === 'expo' || fcmToken.startsWith('ExponentPushToken[');
    const tokenId = `${deviceId}_${fcmToken.substring(0, 20)}`;


    // Store token for this device
    await db.collection('user_push_tokens').doc(tokenId).set({
      deviceId: deviceId,
      pushToken: fcmToken,
      tokenType: isExpoToken ? 'expo' : 'fcm',
      userId: userId || 'anonymous',
      platform: platform || 'unknown',
      registeredAt: admin.firestore.FieldValue.serverTimestamp(),
      lastUsed: admin.firestore.FieldValue.serverTimestamp(),
      active: true
    } as TokenData);


    // For FCM tokens, subscribe to topic
    if (!isExpoToken) {
      try {
        await admin.messaging().subscribeToTopic([fcmToken], FCM_ALERT_TOPIC);
        logger.info('Successfully subscribed FCM token to topic', {
          fcmToken: fcmToken.substring(0, 20) + '...',
          topic: FCM_ALERT_TOPIC
        });
      } catch (subscriptionError: any) {
        logger.error('Error subscribing to FCM topic:', subscriptionError);
      }
    }


    logger.info('Successfully registered push token', {
      deviceId,
      tokenType: isExpoToken ? 'expo' : 'fcm',
      platform,
      userId
    });


    response.json({
      success: true,
      message: `${isExpoToken ? 'Expo' : 'FCM'} token registered successfully`,
      deviceId: deviceId,
      tokenType: isExpoToken ? 'expo' : 'fcm',
      topic: isExpoToken ? null : FCM_ALERT_TOPIC
    });
    return;


  } catch (error: any) {
    logger.error('Error registering push token:', error);
   
    response.status(500).json({
      success: false,
      error: 'Failed to register push token',
      details: error.message
    });
    return;
  }
});


// Function to get movement alerts - UPDATED WITH nRF Cloud LED
export const getMovementAlerts = onRequest({
  cors: true
}, async (request, response) => {
  try {
    const deviceId = request.query.deviceId as string || DEVICE_ID;
    const limit = parseInt(request.query.limit as string) || 10;
    const severity = request.query.severity as string; // 'low', 'medium', 'high'


    let query = db.collection('movement_alerts')
      .where('deviceId', '==', deviceId)
      .orderBy('timestamp', 'desc')
      .limit(limit);


    // Filter by severity if provided
    if (severity && ['low', 'medium', 'high'].includes(severity)) {
      query = query.where('severity', '==', severity);
    }


    const alertsSnapshot = await query.get();
    const alerts = alertsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as MovementAlert[];


    // Get current lock status
    const lockedLocationDoc = await db.collection('locked_locations').doc(deviceId).get();
    const isLocked = lockedLocationDoc.exists;
    const lockData = isLocked ? lockedLocationDoc.data() : null;


    // Check if there are any high-distance alerts that need immediate notification
    const highDistanceAlerts = alerts.filter((alert: MovementAlert) =>
      alert.distance && alert.distance > 10 &&
      !alert.notificationSent &&
      alert.severity !== 'low'
    );


    // Send notifications for high-distance alerts
    for (const alert of highDistanceAlerts) {
      try {
        // Activate LED via nRF Cloud API
        await turnOnMovementAlertLED(deviceId);
        
        // Send notification
        const notificationSent = await sendMovementAlertNotification(alert);
       
        if (notificationSent && alert.id) {
          // Mark alert as notification sent
          await db.collection('movement_alerts').doc(alert.id).update({
            notificationSent: true,
            notificationSentAt: admin.firestore.FieldValue.serverTimestamp(),
            ledActivated: true,
            ledActivatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
         
          logger.info('Movement alert notification sent and LED activated', {
            alertId: alert.id,
            deviceId,
            distance: alert.distance
          });
        }
      } catch (notificationError: any) {
        logger.error('Failed to send notification or activate LED for alert', {
          alertId: alert.id,
          error: notificationError.message
        });
      }
    }


    response.json({
      success: true,
      deviceId: deviceId,
      isLocked: isLocked,
      alertCount: alerts.length,
      highDistanceAlertsCount: highDistanceAlerts.length,
      currentDistance: lockData?.currentDistance || 0,
      lastAlertAt: lockData?.lastAlertAt || null,
      alerts: alerts,
      notificationsSent: highDistanceAlerts.length,
      ledActivated: highDistanceAlerts.length > 0
    });
    return;


  } catch (error: any) {
    logger.error('Error getting movement alerts:', error);
   
    response.status(500).json({
      success: false,
      error: 'Failed to get movement alerts',
      details: error.message
    });
    return;
  }
});



// Scheduled version of getLocationHistory WITH nRF Cloud LED - runs every 5 minutes
export const scheduledLocationHistory = onSchedule("every 2 minutes", async (event) => {
  try {
    logger.info('Starting scheduled location history fetch with movement detection');
   
    const deviceId = DEVICE_ID;
    const latest = true;
   
    // Build query parameters
    const params = new URLSearchParams({
      deviceId: deviceId,
      latest: latest.toString()
    });


    // Make request to nRF Cloud location history API
    const response = await axios.get(`${NRF_CLOUD_BASE_URL}/location/history?${params}`, {
      headers: {
        'Authorization': `Bearer ${NRF_CLOUD_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });


    logger.info('Successfully fetched location history from nRF Cloud (scheduled)', { deviceId, latest });
   
    // Store in Firestore
    await db.collection('location_history').add({
      deviceId: deviceId,
      latest: latest,
      data: response.data,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      source: 'scheduled'
    });


    // Check if device is locked and if it has moved
    const lockedLocationDoc = await db.collection('locked_locations').doc(deviceId).get();
   
    if (lockedLocationDoc.exists && response.data.items && response.data.items.length > 0) {
      const lockedData = lockedLocationDoc.data();
      const currentLocation = response.data.items[0]; // Latest location from nRF Cloud
     
      if (lockedData && currentLocation.lat && currentLocation.lon) {
        const distance = calculateDistance(
          lockedData.location.lat,
          lockedData.location.lon,
          parseFloat(currentLocation.lat),
          parseFloat(currentLocation.lon)
        );
       
        logger.info('Distance check', {
          deviceId,
          distance: distance.toFixed(2),
          threshold: 10,
          moved: distance > 10
        });
       
        if (distance > 10) {
          // Device has moved more than 10m from locked position
          const movementAlert: MovementAlert = {
            deviceId: deviceId,
            alertType: 'movement_detected',
            distance: distance,
            threshold: 10,
            lockedLocation: {
              lat: lockedData.location.lat,
              lon: lockedData.location.lon
            },
            currentLocation: {
              lat: parseFloat(currentLocation.lat),
              lon: parseFloat(currentLocation.lon)
            },
            lockedAt: lockedData.lockedAt,
            detectedAt: new Date().toISOString(),
            severity: distance > 50 ? 'high' : distance > 25 ? 'medium' : 'low',
            message: `Device moved ${distance.toFixed(1)}m away from locked position`,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            source: 'scheduled_check',
            notificationSent: false
          };
         
          // Store movement alert
          const alertRef = await db.collection('movement_alerts').add(movementAlert);
         
          // Activate LED via nRF Cloud API
          await turnOnMovementAlertLED(deviceId);
         
          // Send notifications
          try {
            const notificationSent = await sendMovementAlertNotification(movementAlert);
           
            if (notificationSent) {
              // Update the alert to mark notification as sent
              await alertRef.update({
                notificationSent: true,
                notificationSentAt: admin.firestore.FieldValue.serverTimestamp(),
                ledActivated: true,
                ledActivatedAt: admin.firestore.FieldValue.serverTimestamp()
              });
            }
           
          } catch (notificationError: any) {
            logger.error('Error sending movement alert:', notificationError);
          }
         
          // Also update the locked location document with latest alert info
          await db.collection('locked_locations').doc(deviceId).update({
            lastMovementAlert: movementAlert,
            lastAlertAt: admin.firestore.FieldValue.serverTimestamp(),
            currentDistance: distance,
            alertCount: admin.firestore.FieldValue.increment(1)
          });
         
          logger.warn('MOVEMENT ALERT, NOTIFICATION SENT, AND LED ACTIVATED', {
            deviceId,
            distance: distance.toFixed(2) + 'm',
            message: movementAlert.message
          });
         
        } else {
          // Device is within safe distance
          // Update the locked location with current status
          await db.collection('locked_locations').doc(deviceId).update({
            lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
            currentDistance: distance,
            status: 'locked_safe'
          });
         
          logger.info('Device within safe distance', {
            deviceId,
            distance: distance.toFixed(2) + 'm'
          });
        }
      }
    }


    logger.info('Scheduled location history fetch completed successfully');


  } catch (error: any) {
    logger.error('Scheduled location history fetch failed:', error);
  }
});


export const getLockedLocation = onRequest({
  cors: true
}, async (request, response) => {
  try {
    const deviceId = request.query.deviceId as string || DEVICE_ID;


    // Validate required fields
    if (!deviceId) {
      response.status(400).json({
        success: false,
        error: 'Missing required query parameter: deviceId'
      });
      return;
    }


    // Get the locked location document
    const lockedLocationDoc = await db.collection('locked_locations').doc(deviceId).get();
   
    if (!lockedLocationDoc.exists) {
      response.json({
        success: true,
        isLocked: false,
        deviceId: deviceId,
        message: 'No locked location found for this device'
      });
      return;
    }


    const lockedData = lockedLocationDoc.data();
   
    logger.info('Successfully retrieved locked location', { deviceId });


    response.json({
      success: true,
      isLocked: true,
      deviceId: deviceId,
      lockedLocation: lockedData,
      lockedAt: lockedData?.lockedAt || lockedData?.timestamp,
      currentDistance: lockedData?.currentDistance || 0,
      lastAlertAt: lockedData?.lastAlertAt || null,
      alertCount: lockedData?.alertCount || 0,
      status: lockedData?.status || 'locked'
    });
    return;


  } catch (error: any) {
    logger.error('Error getting locked location:', error);
   
    response.status(500).json({
      success: false,
      error: 'Failed to get locked location',
      details: error.message
    });
    return;
  }
});
