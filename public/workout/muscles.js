// Muscle reference data.
//
// Each entry is one tappable group on the body map. The shape is deliberately
// flat and boring so it can be extended by hand (or by a research pass) without
// touching the app code:
//
//   name        display name
//   latin       anatomical name, shown small under the title
//   heads       sub-divisions worth naming, or null
//   actions     what the muscle does, mechanically
//   everyday    where you actually use it when you are not in a gym
//   training    how the muscle responds — rep ranges, range of motion, quirks
//   exercises   [{ name, kind, equipment, dose, why }]
//                 kind      compound | isolation | carry | stability
//                 dose      a starting prescription, not a law
//                 why       the reason this one earns a place on the list
//
// `why` lines describe findings that are well replicated and uncontroversial.
// Anything that needs a specific citation should get a `sources: []` array
// added alongside it rather than a number baked into the prose.

export const MUSCLES = {
  chest: {
    name: 'Chest',
    latin: 'Pectoralis major',
    heads: 'Clavicular (upper) · Sternal (mid) · Costal (lower)',
    actions: [
      'Pushes your arm forward, away from your torso',
      'Brings your arm across the front of your body',
      'Rotates the upper arm inward',
    ],
    everyday: [
      'Pushing a heavy door open',
      'Pushing a stalled car or a loaded shopping cart',
      'Pressing yourself up off the floor',
      'Carrying a box held against your chest',
      'Closing a heavy car boot or hatch',
    ],
    training:
      'Responds well to both heavy pressing and long-length stretch work. The upper (clavicular) fibres need an incline — flat pressing alone tends to under-develop them. 6–12 reps for presses, 10–20 for flyes.',
    exercises: [
      {
        name: 'Barbell bench press',
        kind: 'compound',
        equipment: 'Barbell + bench',
        dose: '3–5 sets × 5–8 reps',
        why: 'The highest-load pec exercise most people can do safely, and load is what drives the sternal fibres. Progress here reliably tracks chest size.',
      },
      {
        name: 'Incline dumbbell press',
        kind: 'compound',
        equipment: 'Dumbbells + incline bench (~30°)',
        dose: '3–4 sets × 8–12 reps',
        why: 'The clavicular head is meaningfully more active on an incline. Dumbbells also allow a deeper bottom position than a barbell, which the chest benefits from.',
      },
      {
        name: 'Weighted dip (torso leaned forward)',
        kind: 'compound',
        equipment: 'Dip bars + belt',
        dose: '3–4 sets × 6–10 reps',
        why: 'Loads the lower chest at a long muscle length. Leaning the torso forward shifts the work from triceps to pecs.',
      },
      {
        name: 'Cable or dumbbell fly',
        kind: 'isolation',
        equipment: 'Cables or dumbbells',
        dose: '3 sets × 12–20 reps',
        why: 'Trains the pec through horizontal adduction with a deep stretch at the bottom. Training a muscle at long lengths is one of the more consistent levers for growth.',
      },
      {
        name: 'Push-up (feet elevated, deep)',
        kind: 'compound',
        equipment: 'None',
        dose: '3 sets to 2–3 reps in reserve',
        why: 'No equipment, and elevating the feet plus using handles for extra depth keeps it hard enough to matter long after standard push-ups get easy.',
      },
    ],
  },

  shoulders: {
    name: 'Shoulders',
    latin: 'Deltoideus',
    heads: 'Anterior (front) · Lateral (side) · Posterior (rear)',
    actions: [
      'Front head: raises the arm forward and presses overhead',
      'Side head: lifts the arm out to the side',
      'Rear head: pulls the arm backward and rotates it outward',
    ],
    everyday: [
      'Putting a bag in an overhead locker',
      'Reaching for something on a high shelf',
      'Holding a phone or a book up in front of you',
      'Putting on a jacket or reaching behind you for a seatbelt',
      'Stopping heavy shopping bags from swinging into your legs',
    ],
    training:
      'Three heads with three different jobs — pressing alone builds the front head and leaves the side and rear behind. The side head is what makes shoulders look wide, and it responds to high-rep, high-frequency work. Rear delts recover fast and can be trained most sessions.',
    exercises: [
      {
        name: 'Overhead press',
        kind: 'compound',
        equipment: 'Barbell or dumbbells',
        dose: '3–4 sets × 5–10 reps',
        why: 'The heaviest thing you can do for the front head, and it loads the whole shoulder girdle and trunk at the same time.',
      },
      {
        name: 'Cable lateral raise',
        kind: 'isolation',
        equipment: 'Low cable pulley',
        dose: '3–4 sets × 12–20 reps',
        why: 'The side head is nearly the only muscle that can do this movement, so there is nowhere for the work to hide. A cable keeps tension at the bottom where dumbbells go slack.',
      },
      {
        name: 'Reverse pec-deck / cable rear fly',
        kind: 'isolation',
        equipment: 'Machine or cables',
        dose: '3–4 sets × 15–25 reps',
        why: 'Rear delts are small, recover quickly, and are chronically under-trained relative to the front. High reps, often, works better than heavy.',
      },
      {
        name: 'Face pull',
        kind: 'isolation',
        equipment: 'Rope + cable',
        dose: '3 sets × 15–20 reps',
        why: 'Trains rear delt plus external rotation together — the pattern that pressing volume tends to erode.',
      },
      {
        name: 'Dumbbell lateral raise',
        kind: 'isolation',
        equipment: 'Dumbbells',
        dose: '3 sets × 12–20 reps',
        why: 'The simplest side-delt movement there is. Lead with the elbow and stop the swing — momentum moves the work to the traps.',
      },
    ],
  },

  biceps: {
    name: 'Biceps',
    latin: 'Biceps brachii',
    heads: 'Long head (outer) · Short head (inner) · Brachialis underneath',
    actions: [
      'Bends the elbow',
      'Turns the palm upward (supination)',
      'Assists in raising the arm forward at the shoulder',
    ],
    everyday: [
      'Carrying grocery bags up the stairs',
      'Picking up a child or a heavy suitcase',
      'Pulling a heavy door toward you',
      'Carrying a laundry basket or a full box',
      'Turning a stiff doorknob or a screwdriver',
    ],
    training:
      'The long head crosses the shoulder, so it is only fully stretched when the arm is behind the body — which is why the incline bench matters. The brachialis sits underneath and pushes the biceps up when it grows; it is trained with a neutral or pronated grip. 8–15 reps.',
    exercises: [
      {
        name: 'Incline dumbbell curl',
        kind: 'isolation',
        equipment: 'Dumbbells + incline bench',
        dose: '3–4 sets × 8–12 reps',
        why: 'The arm hanging behind the torso puts the long head at its longest. Training at long muscle lengths is one of the most reliably reproduced growth findings.',
      },
      {
        name: 'Preacher or spider curl',
        kind: 'isolation',
        equipment: 'Preacher bench + EZ bar or dumbbells',
        dose: '3 sets × 10–15 reps',
        why: 'Removes swing entirely and loads the short head hard in the shortened position — a useful contrast to the incline curl.',
      },
      {
        name: 'Hammer curl',
        kind: 'isolation',
        equipment: 'Dumbbells or rope cable',
        dose: '3 sets × 10–15 reps',
        why: 'Neutral grip shifts work to the brachialis and brachioradialis. These add visible thickness that biceps work alone will not.',
      },
      {
        name: 'Chin-up',
        kind: 'compound',
        equipment: 'Pull-up bar',
        dose: '3–4 sets × 5–10 reps',
        why: 'Biceps activity in a supinated chin-up rivals direct curling, and you can load it heavily with a belt.',
      },
      {
        name: 'Cable curl',
        kind: 'isolation',
        equipment: 'Low pulley',
        dose: '3 sets × 12–15 reps',
        why: 'Constant tension through the whole range, with no dead spot at the top the way free weights have.',
      },
    ],
  },

  triceps: {
    name: 'Triceps',
    latin: 'Triceps brachii',
    heads: 'Long head · Lateral head · Medial head',
    actions: [
      'Straightens the elbow',
      'Long head also pulls the arm backward and stabilises the shoulder',
    ],
    everyday: [
      'Pushing yourself up out of a low chair or the bath',
      'Pushing a lawnmower or a heavy trolley',
      'Bracing your arms if you trip and fall forward',
      'Closing a heavy door behind you',
      'Reaching up to put something away on a shelf',
    ],
    training:
      'Two-thirds of your upper arm is triceps. The long head crosses the shoulder, so it is only fully stretched with the arm overhead — pushdowns alone leave it short. 8–15 reps for extensions, 5–10 for pressing.',
    exercises: [
      {
        name: 'Overhead cable or dumbbell extension',
        kind: 'isolation',
        equipment: 'Cable rope or dumbbell',
        dose: '3–4 sets × 10–15 reps',
        why: 'Direct comparisons of overhead versus pushdown training show clearly greater long-head growth from the overhead position, because that is the only way to lengthen it.',
      },
      {
        name: 'Close-grip bench press',
        kind: 'compound',
        equipment: 'Barbell + bench',
        dose: '3–4 sets × 6–10 reps',
        why: 'The heaviest loadable triceps movement, and it carries over directly to your regular bench press.',
      },
      {
        name: 'Dip (upright torso)',
        kind: 'compound',
        equipment: 'Dip bars',
        dose: '3 sets × 8–12 reps',
        why: 'Staying vertical keeps the work on triceps rather than chest. Easy to load with a belt as you get stronger.',
      },
      {
        name: 'Cable pushdown',
        kind: 'isolation',
        equipment: 'Cable + bar or rope',
        dose: '3 sets × 12–20 reps',
        why: 'Hits the lateral and medial heads with low joint stress. A good finisher — just not a substitute for overhead work.',
      },
      {
        name: 'Skull crusher',
        kind: 'isolation',
        equipment: 'EZ bar + bench',
        dose: '3 sets × 10–12 reps',
        why: 'Loads the triceps at a long length lying down. Lower behind the head rather than to the forehead to lengthen the long head further.',
      },
    ],
  },

  forearms: {
    name: 'Forearms',
    latin: 'Flexor & extensor group, brachioradialis',
    heads: 'Wrist flexors · Wrist extensors · Brachioradialis',
    actions: [
      'Closes the hand and grips',
      'Bends and straightens the wrist',
      'Rotates the forearm (palm up / palm down)',
    ],
    everyday: [
      'Opening a stuck jar lid',
      'Carrying luggage or shopping in one trip',
      'Holding a steering wheel or handlebars',
      'Hanging onto a rail on a moving bus or train',
      'Hours of typing, DIY, or using hand tools',
    ],
    training:
      'Grip is trained by holding, not just by curling. Grip strength is one of the strongest single predictors of all-cause mortality in large population studies — it is worth training for its own sake, not only to help your other lifts. Heavy carries plus direct wrist work.',
    exercises: [
      {
        name: "Farmer's carry",
        kind: 'carry',
        equipment: 'Heavy dumbbells or trap bar',
        dose: '3–4 rounds × 30–60 s',
        why: 'Trains grip endurance under real load while also loading traps and trunk. The single most transferable grip exercise.',
      },
      {
        name: 'Dead hang',
        kind: 'carry',
        equipment: 'Pull-up bar',
        dose: '3 sets to failure',
        why: 'Free, measurable, and it decompresses the shoulders. Add weight once you pass a minute.',
      },
      {
        name: 'Wrist curl + wrist extension',
        kind: 'isolation',
        equipment: 'Dumbbell or barbell',
        dose: '2–3 sets × 15–20 each',
        why: 'Direct work for the flexors and, importantly, the extensors — the side almost everyone neglects and the one implicated in tennis elbow.',
      },
      {
        name: 'Reverse curl',
        kind: 'isolation',
        equipment: 'EZ bar or dumbbells',
        dose: '3 sets × 10–15 reps',
        why: 'Loads brachioradialis and the extensors together. Builds the visible upper-forearm mass.',
      },
      {
        name: 'Plate pinch or thick-grip hold',
        kind: 'carry',
        equipment: 'Plates or fat grips',
        dose: '3 sets × 20–40 s',
        why: 'Trains pinch grip and thumb strength, which normal bar work barely touches.',
      },
    ],
  },

  abs: {
    name: 'Abs',
    latin: 'Rectus abdominis',
    heads: 'Rectus abdominis · Transversus abdominis (deep)',
    actions: [
      'Curls the torso forward',
      'Tilts the pelvis backward',
      'Braces the trunk so force can travel through it',
    ],
    everyday: [
      'Getting out of bed',
      'Bracing before you pick up anything heavy',
      'Coughing, sneezing, or laughing hard',
      'Sitting upright for long periods without slumping',
      'Protecting your lower back during any lift or carry',
    ],
    training:
      'Abs are skeletal muscle and respond to progressive load like anything else — endless unweighted crunches stop working. Train them in two ways: flexion under load, and anti-extension bracing. 8–20 reps loaded, or timed holds.',
    exercises: [
      {
        name: 'Hanging leg raise',
        kind: 'compound',
        equipment: 'Pull-up bar',
        dose: '3–4 sets × 8–15 reps',
        why: 'Loads the abs through a long range with the spine lengthened, and trains grip at the same time. Curl the pelvis up rather than just swinging the legs.',
      },
      {
        name: 'Cable crunch',
        kind: 'isolation',
        equipment: 'Cable + rope',
        dose: '3–4 sets × 10–15 reps',
        why: 'The most easily progressible ab exercise there is — you can add 2.5 kg a week for months, which bodyweight work cannot offer.',
      },
      {
        name: 'Ab wheel rollout',
        kind: 'stability',
        equipment: 'Ab wheel',
        dose: '3 sets × 6–12 reps',
        why: 'Anti-extension under a long lever. Extremely hard, and it produces very high abdominal activity relative to a plank.',
      },
      {
        name: 'RKC plank',
        kind: 'stability',
        equipment: 'None',
        dose: '3 sets × 10–20 s',
        why: 'A plank done with maximal glute and ab contraction. Ten hard seconds beats three easy minutes.',
      },
      {
        name: 'Dead bug',
        kind: 'stability',
        equipment: 'None',
        dose: '3 sets × 8–10 per side',
        why: 'Teaches you to keep the ribs down and the low back flat while the limbs move — the pattern that protects your back when lifting.',
      },
    ],
  },

  obliques: {
    name: 'Obliques',
    latin: 'Obliquus externus & internus',
    heads: 'External oblique · Internal oblique · Serratus alongside',
    actions: [
      'Rotates the torso',
      'Bends the torso sideways',
      'Resists rotation and side-bend — its main real job',
    ],
    everyday: [
      'Twisting to look behind you while reversing the car',
      'Carrying a heavy bag on one side without listing over',
      'Reaching across your body for something',
      'Getting out of a car seat',
      'Any throwing, swinging or striking motion',
    ],
    training:
      'Most oblique work in real life is resisting movement rather than creating it. Train anti-rotation and offset carries first, and add rotation work second. Avoid loading heavy twisting through a rounded spine.',
    exercises: [
      {
        name: 'Pallof press',
        kind: 'stability',
        equipment: 'Cable or band',
        dose: '3 sets × 10–12 per side',
        why: 'Pure anti-rotation. Trains the obliques in the job they actually do, with no spinal loading.',
      },
      {
        name: 'Suitcase carry',
        kind: 'carry',
        equipment: 'One heavy dumbbell',
        dose: '3 rounds × 30–40 s per side',
        why: 'A one-sided load forces the obliques and QL to keep you vertical. Directly mimics carrying shopping or a toolbox.',
      },
      {
        name: 'Side plank',
        kind: 'stability',
        equipment: 'None',
        dose: '3 sets × 20–45 s per side',
        why: 'Lateral trunk endurance, and one of the safer options if your lower back is cranky.',
      },
      {
        name: 'Cable woodchop',
        kind: 'isolation',
        equipment: 'Cable',
        dose: '3 sets × 12–15 per side',
        why: 'Loaded rotation through a full range. Drive with the hips and let the trunk follow rather than yanking with the arms.',
      },
      {
        name: 'Hanging oblique raise',
        kind: 'compound',
        equipment: 'Pull-up bar',
        dose: '3 sets × 8–12 per side',
        why: 'Combines the leg raise with a side-bend, loading the obliques at a long length.',
      },
    ],
  },

  quads: {
    name: 'Quads',
    latin: 'Quadriceps femoris',
    heads: 'Rectus femoris · Vastus lateralis · medialis · intermedius',
    actions: [
      'Straightens the knee',
      'Rectus femoris also lifts the thigh at the hip',
      'Controls your descent when you sit, step down, or walk downhill',
    ],
    everyday: [
      'Standing up from a chair or the toilet',
      'Climbing stairs, and controlling yourself going back down',
      'Squatting down to pick something off the floor',
      'Walking downhill or down a steep path',
      'Getting out of a low car seat',
    ],
    training:
      'Deep, full-range work builds noticeably more quad than partial-range work — this is one of the clearest range-of-motion findings in the literature. Rectus femoris crosses the hip and is poorly trained by squats alone, so add a knee-extension movement. 6–12 reps on compounds, 10–20 on extensions.',
    exercises: [
      {
        name: 'Back or front squat (full depth)',
        kind: 'compound',
        equipment: 'Barbell + rack',
        dose: '3–5 sets × 5–10 reps',
        why: 'The reference lift for lower-body strength. Depth matters — deep squats outperform partial squats for quad growth at matched load.',
      },
      {
        name: 'Leg press',
        kind: 'compound',
        equipment: 'Leg press machine',
        dose: '3–4 sets × 8–15 reps',
        why: 'Lets you load the quads heavily without the trunk or balance being the limiting factor. Useful volume that does not tax recovery like squatting.',
      },
      {
        name: 'Bulgarian split squat',
        kind: 'compound',
        equipment: 'Dumbbells + bench',
        dose: '3 sets × 8–12 per leg',
        why: 'Single-leg, long range, and it exposes and fixes side-to-side differences. Brutal with modest weight, which is easy on the spine.',
      },
      {
        name: 'Leg extension',
        kind: 'isolation',
        equipment: 'Leg extension machine',
        dose: '3 sets × 12–20 reps',
        why: 'The only common movement that properly trains rectus femoris, because it extends the knee without simultaneously flexing the hip.',
      },
      {
        name: 'Hack squat or pendulum squat',
        kind: 'compound',
        equipment: 'Machine',
        dose: '3–4 sets × 8–12 reps',
        why: 'A fixed path lets you go deeper and closer to failure than a free squat, which is where most quad growth is available.',
      },
    ],
  },

  adductors: {
    name: 'Adductors',
    latin: 'Adductor magnus, longus, brevis, gracilis',
    heads: 'Adductor magnus (largest) · longus · brevis · gracilis',
    actions: [
      'Pulls the thigh inward toward the midline',
      'Adductor magnus also extends the hip, like a hamstring',
      'Stabilises the pelvis every time you take a step',
    ],
    everyday: [
      'Keeping your legs tracking straight when you walk or pivot',
      'Swinging a leg over a bike',
      'Side-stepping, or catching yourself on slippery ground',
      'Getting in and out of a car without twisting a knee',
      'Staying stable on uneven ground or a hillside',
    ],
    training:
      'One of the most under-trained groups, and a very common site of strains in sport. Adductor magnus is huge and behaves partly like a hamstring, so wide-stance and deep hip-flexion work loads it hard. 10–20 reps.',
    exercises: [
      {
        name: 'Copenhagen plank',
        kind: 'stability',
        equipment: 'Bench',
        dose: '3 sets × 10–30 s per side',
        why: 'The Copenhagen adduction protocol substantially reduces groin injury rates in footballers — one of the better-supported prevention exercises in sports medicine.',
      },
      {
        name: 'Adductor machine',
        kind: 'isolation',
        equipment: 'Hip adduction machine',
        dose: '3 sets × 12–20 reps',
        why: 'Direct, easily progressible loading through a full range. Unfashionable, and genuinely effective.',
      },
      {
        name: 'Sumo deadlift',
        kind: 'compound',
        equipment: 'Barbell',
        dose: '3–4 sets × 5–8 reps',
        why: 'The wide stance puts adductor magnus under heavy load as a hip extensor.',
      },
      {
        name: 'Cossack squat',
        kind: 'compound',
        equipment: 'Bodyweight or a light plate',
        dose: '3 sets × 6–10 per side',
        why: 'Loads the adductors at a long length and builds hip range at the same time.',
      },
      {
        name: 'Deep wide-stance squat',
        kind: 'compound',
        equipment: 'Barbell or goblet',
        dose: '3 sets × 8–12 reps',
        why: 'Adductor contribution rises sharply with stance width and depth.',
      },
    ],
  },

  abductors: {
    name: 'Abductors',
    latin: 'Gluteus medius & minimus, TFL',
    heads: 'Gluteus medius · Gluteus minimus · Tensor fasciae latae',
    actions: [
      'Lifts the leg out to the side',
      'Stops the pelvis dropping when you stand on one leg',
      'Keeps the knee tracking over the foot',
    ],
    everyday: [
      'Standing on one leg to put trousers on',
      'Every single step you take — they stop your hip collapsing',
      'Stepping sideways out of the way of something',
      'Balance on stairs, kerbs, and uneven pavements',
      'Staying steady when someone bumps into you',
    ],
    training:
      'Weakness here shows up as the knee caving inward under load, and is associated with patellofemoral (runner\'s) knee pain. Best trained with a mix of loaded abduction and single-leg stability work. 12–25 reps.',
    exercises: [
      {
        name: 'Hip abduction machine',
        kind: 'isolation',
        equipment: 'Abduction machine',
        dose: '3 sets × 15–25 reps',
        why: 'The most direct and progressible loading for glute medius. Lean the torso forward slightly to bias the upper glute.',
      },
      {
        name: 'Banded lateral walk',
        kind: 'stability',
        equipment: 'Mini band',
        dose: '3 sets × 15–20 steps each way',
        why: 'Trains abduction under continuous tension in a standing position — closer to how the muscle is used in gait.',
      },
      {
        name: 'Single-leg Romanian deadlift',
        kind: 'compound',
        equipment: 'Dumbbell or kettlebell',
        dose: '3 sets × 8–10 per leg',
        why: 'Loads the hamstrings while forcing the abductors to keep the pelvis level. Balance and strength in one movement.',
      },
      {
        name: 'Side-lying hip abduction',
        kind: 'isolation',
        equipment: 'Bodyweight or ankle weight',
        dose: '3 sets × 15–20 per side',
        why: 'Isolates glute medius with no equipment, and is a staple of rehab protocols for knee and hip pain.',
      },
      {
        name: 'Step-up',
        kind: 'compound',
        equipment: 'Box + dumbbells',
        dose: '3 sets × 8–12 per leg',
        why: 'Loaded single-leg control through a full range. Drive through the heel of the top foot and do not push off the trailing leg.',
      },
    ],
  },

  calves: {
    name: 'Calves',
    latin: 'Gastrocnemius & soleus',
    heads: 'Gastrocnemius (two heads, crosses knee) · Soleus (deep)',
    actions: [
      'Points the foot down — every push-off when you walk or run',
      'Gastrocnemius also assists in bending the knee',
      'Soleus does most of the work of keeping you upright when standing',
    ],
    everyday: [
      'Every step you take, all day',
      'Standing on tiptoes to reach something',
      'Walking uphill or up stairs',
      'Working the pedals when driving',
      'Ankle stability on uneven ground — this is what stops rolled ankles',
    ],
    training:
      'Knee angle decides which muscle you are training: gastrocnemius crosses the knee, so it goes slack when you sit — a seated calf raise is a soleus exercise, a standing one is a gastrocnemius exercise. You need both. Full stretch at the bottom matters more here than almost anywhere else. 10–20 reps, with a pause at the bottom.',
    exercises: [
      {
        name: 'Standing calf raise',
        kind: 'isolation',
        equipment: 'Machine, or a step + dumbbell',
        dose: '4 sets × 10–15 reps',
        why: 'Knee straight, so gastrocnemius is loaded through its full length. Pause two seconds at the bottom of every rep.',
      },
      {
        name: 'Seated calf raise',
        kind: 'isolation',
        equipment: 'Seated calf machine',
        dose: '3–4 sets × 15–20 reps',
        why: 'The only way to properly load the soleus, which is the larger of the two and the one that carries you all day.',
      },
      {
        name: 'Leg press calf press',
        kind: 'isolation',
        equipment: 'Leg press machine',
        dose: '3 sets × 12–20 reps',
        why: 'Heavy loading with the back supported, and an easy way to get a deep stretch under load.',
      },
      {
        name: 'Tibialis raise',
        kind: 'isolation',
        equipment: 'Wall or tib bar',
        dose: '3 sets × 15–25 reps',
        why: 'Trains the muscle on the front of the shin — the antagonist. Strengthening it helps with shin splints and ankle control.',
      },
      {
        name: 'Single-leg calf raise off a step',
        kind: 'isolation',
        equipment: 'Step',
        dose: '3 sets × 12–20 per leg',
        why: 'Bodyweight is enough load for one leg, and the step gives you the stretch that flat-floor raises miss.',
      },
    ],
  },

  traps: {
    name: 'Traps',
    latin: 'Trapezius',
    heads: 'Upper · Middle · Lower',
    actions: [
      'Upper: shrugs the shoulders and supports the head',
      'Middle: pulls the shoulder blades together',
      'Lower: pulls the shoulder blades down, which lets you press overhead safely',
    ],
    everyday: [
      'Carrying heavy bags without your shoulders being dragged down',
      'Shouldering a loaded backpack',
      'Holding your head up over a desk or a phone all day',
      'Looking up, or holding a position while working overhead',
      'General upright posture through the day',
    ],
    training:
      'The upper trap gets plenty of work from any heavy carry or deadlift. The lower trap is the one that is usually weak, especially in desk workers, and it needs deliberate overhead and Y-raise work. 8–15 reps on shrugs, higher on lower-trap work.',
    exercises: [
      {
        name: 'Barbell or dumbbell shrug',
        kind: 'isolation',
        equipment: 'Barbell or dumbbells',
        dose: '3–4 sets × 8–15 reps',
        why: 'Straight up and down, with a pause at the top. Rolling the shoulders adds nothing and irritates the joint.',
      },
      {
        name: "Farmer's carry",
        kind: 'carry',
        equipment: 'Heavy dumbbells or trap bar',
        dose: '3–4 rounds × 30–60 s',
        why: 'Loads the traps isometrically for long durations while also training grip and trunk. Very high value per exercise.',
      },
      {
        name: 'Prone Y raise',
        kind: 'isolation',
        equipment: 'Light dumbbells + incline bench',
        dose: '3 sets × 12–15 reps',
        why: 'One of the few movements that targets the lower trap directly. Use very light weight — 2–5 kg is plenty.',
      },
      {
        name: 'Face pull',
        kind: 'isolation',
        equipment: 'Rope + cable',
        dose: '3 sets × 15–20 reps',
        why: 'Middle trap, rear delt and external rotators together. A good counterweight to pressing volume.',
      },
      {
        name: 'Deadlift',
        kind: 'compound',
        equipment: 'Barbell',
        dose: '3–4 sets × 3–6 reps',
        why: 'The whole trapezius works isometrically to hold the shoulder girdle together under the heaviest load you will handle.',
      },
    ],
  },

  'upper-back': {
    name: 'Upper Back',
    latin: 'Rhomboids & middle trapezius',
    heads: 'Rhomboid major & minor · Middle trapezius',
    actions: [
      'Pulls the shoulder blades together and back',
      'Holds the shoulder blades against the ribcage',
      'Keeps your chest open instead of rounded forward',
    ],
    everyday: [
      'Pulling a heavy door toward you',
      'Sitting upright at a desk without rounding forward',
      'Pulling a suitcase or starting a lawnmower',
      'Reaching behind you into the back seat',
      'Holding good posture when you are tired',
    ],
    training:
      'The direct antagonist to everything you do sitting at a desk or pressing in the gym. Row volume is the answer, and the pause at the end of each rep is what actually makes it work. 8–15 reps with a one-second squeeze.',
    exercises: [
      {
        name: 'Chest-supported row',
        kind: 'compound',
        equipment: 'Incline bench + dumbbells, or machine',
        dose: '3–4 sets × 8–12 reps',
        why: 'The chest support removes the lower back and any cheating, so all the load lands on the upper back.',
      },
      {
        name: 'Seated cable row',
        kind: 'compound',
        equipment: 'Cable row station',
        dose: '3–4 sets × 10–15 reps',
        why: 'Constant tension and an easy full range. Pull the shoulder blades together first, then bend the elbows.',
      },
      {
        name: 'Inverted row',
        kind: 'compound',
        equipment: 'Bar or rings',
        dose: '3 sets × 8–15 reps',
        why: 'Bodyweight, scalable by changing your foot position, and it trains the same pattern as a pull-up in reverse.',
      },
      {
        name: 'Face pull',
        kind: 'isolation',
        equipment: 'Rope + cable',
        dose: '3 sets × 15–20 reps',
        why: 'Cheap insurance for shoulder health, and it hits mid-trap and rhomboids in a range rows do not.',
      },
      {
        name: 'Prone T raise',
        kind: 'isolation',
        equipment: 'Light dumbbells',
        dose: '3 sets × 12–15 reps',
        why: 'Isolates scapular retraction with no arm involvement. Light weight, slow tempo.',
      },
    ],
  },

  lats: {
    name: 'Lats',
    latin: 'Latissimus dorsi',
    heads: 'Costal & iliac fibres · Teres major alongside',
    actions: [
      'Pulls the arm down from overhead',
      'Pulls the arm backward, toward and behind the torso',
      'Rotates the upper arm inward',
    ],
    everyday: [
      'Pulling yourself up out of a swimming pool',
      'Pulling a heavy door or a rope',
      'Pushing up off the arms of a chair to stand',
      'Swimming any stroke',
      'Lifting yourself over a fence or into a loft hatch',
    ],
    training:
      'The largest muscle in the upper body and the one that gives the back its width. It needs a full stretch overhead and a full contraction at the bottom — cutting range at the top is the most common mistake. 6–12 reps on loaded pulls, up to 15 on cables.',
    exercises: [
      {
        name: 'Pull-up / chin-up',
        kind: 'compound',
        equipment: 'Pull-up bar',
        dose: '3–5 sets × 5–10 reps',
        why: 'The benchmark vertical pull. Start from a full hang every rep — the stretched bottom position is where the lat does most of its growing.',
      },
      {
        name: 'Lat pulldown',
        kind: 'compound',
        equipment: 'Pulldown machine',
        dose: '3–4 sets × 8–12 reps',
        why: 'Lat activity is comparable to a pull-up, and you can load below bodyweight or above it, which makes it far easier to progress.',
      },
      {
        name: 'Single-arm dumbbell row',
        kind: 'compound',
        equipment: 'Dumbbell + bench',
        dose: '3–4 sets × 8–12 per side',
        why: 'One side at a time gives a longer range and lets you fix a strength difference between sides.',
      },
      {
        name: 'Straight-arm pulldown',
        kind: 'isolation',
        equipment: 'Cable',
        dose: '3 sets × 12–15 reps',
        why: 'The only common lat exercise with the elbow out of the equation, so the biceps cannot take over.',
      },
      {
        name: 'Barbell row',
        kind: 'compound',
        equipment: 'Barbell',
        dose: '3–4 sets × 6–10 reps',
        why: 'Heaviest horizontal pull available, and it loads the whole posterior chain as a bonus. Keep the torso angle honest.',
      },
    ],
  },

  'lower-back': {
    name: 'Lower Back',
    latin: 'Erector spinae & quadratus lumborum',
    heads: 'Erector spinae (three columns) · QL · Multifidus (deep)',
    actions: [
      'Straightens the spine from a bent-over position',
      'Holds the spine rigid so your legs and hips can move load',
      'Resists side-bending and rotation',
    ],
    everyday: [
      'Bending down to pick anything up off the floor',
      'Standing for a long stretch without aching',
      'Carrying a heavy load in front of you',
      'Gardening, DIY, or anything done bent over',
      'Getting out of bed in the morning',
    ],
    training:
      'A strong lower back is protective, not risky. Progressively loaded lumbar extension training is one of the better-supported interventions for reducing low-back pain — the muscle needs to be trained through range, not only braced. Moderate loads, 8–15 reps, and no ego.',
    exercises: [
      {
        name: 'Romanian deadlift',
        kind: 'compound',
        equipment: 'Barbell or dumbbells',
        dose: '3–4 sets × 6–10 reps',
        why: 'Trains the whole posterior chain isometrically at the spine and dynamically at the hip — the exact pattern that safe lifting requires.',
      },
      {
        name: '45° back extension',
        kind: 'isolation',
        equipment: 'Back extension bench',
        dose: '3 sets × 10–15 reps',
        why: 'Direct, progressible lumbar extension through a full range. Hold a plate at the chest once bodyweight is easy.',
      },
      {
        name: 'Conventional deadlift',
        kind: 'compound',
        equipment: 'Barbell',
        dose: '3–4 sets × 3–6 reps',
        why: 'The heaviest full-body loading there is, and the erectors are the limiting factor in holding position under it.',
      },
      {
        name: 'Good morning',
        kind: 'compound',
        equipment: 'Barbell',
        dose: '3 sets × 8–12 reps',
        why: 'Puts the spinal erectors under a long lever with modest load. Start much lighter than you think you need.',
      },
      {
        name: 'Bird dog',
        kind: 'stability',
        equipment: 'None',
        dose: '3 sets × 8–10 per side',
        why: 'Low-load, high-control anti-rotation work. A reliable warm-up or a starting point if your back is currently sore.',
      },
    ],
  },

  glutes: {
    name: 'Glutes',
    latin: 'Gluteus maximus, medius & minimus',
    heads: 'Gluteus maximus · medius · minimus',
    actions: [
      'Drives the hip from bent to straight — the main engine of standing, climbing and sprinting',
      'Rotates the thigh outward',
      'Keeps the pelvis level over the standing leg',
    ],
    everyday: [
      'Standing up from a chair or the floor',
      'Climbing stairs and walking uphill',
      'Sprinting for a bus',
      'Getting up off the ground without using your hands',
      'Hip stability on every single step',
    ],
    training:
      'The largest muscle in the body, and it needs loading at both ends of its range: hip thrusts load it hardest in the shortened position, squats and RDLs load it stretched. Doing both beats doing either. 6–12 reps on the heavy work, 12–20 on the rest.',
    exercises: [
      {
        name: 'Barbell hip thrust',
        kind: 'compound',
        equipment: 'Barbell + bench',
        dose: '3–4 sets × 8–12 reps',
        why: 'Produces the highest gluteus maximus activity of the common lifts, because peak load lines up with peak hip extension.',
      },
      {
        name: 'Romanian deadlift',
        kind: 'compound',
        equipment: 'Barbell or dumbbells',
        dose: '3–4 sets × 6–10 reps',
        why: 'Loads the glutes and hamstrings at long length, which the hip thrust does not. The pairing covers the whole range.',
      },
      {
        name: 'Bulgarian split squat',
        kind: 'compound',
        equipment: 'Dumbbells + bench',
        dose: '3 sets × 8–12 per leg',
        why: 'Deep hip flexion under load on one leg, which recruits the glute far more than a two-legged squat at the same total weight.',
      },
      {
        name: 'Back squat (below parallel)',
        kind: 'compound',
        equipment: 'Barbell + rack',
        dose: '3–5 sets × 5–10 reps',
        why: 'Glute contribution climbs sharply below parallel. If you stop high, you are training quads only.',
      },
      {
        name: 'Cable kickback / hip extension',
        kind: 'isolation',
        equipment: 'Cable + ankle strap',
        dose: '3 sets × 12–20 per side',
        why: 'Isolation with no lower-back cost, useful for adding glute volume without adding fatigue.',
      },
    ],
  },

  hamstrings: {
    name: 'Hamstrings',
    latin: 'Biceps femoris, semitendinosus, semimembranosus',
    heads: 'Biceps femoris (long & short) · Semitendinosus · Semimembranosus',
    actions: [
      'Bends the knee',
      'Extends the hip, pulling the thigh backward',
      'Decelerates the lower leg on every stride — its most important job',
    ],
    everyday: [
      'Walking and running — they slow the swinging leg down each step',
      'Bending forward to pick something up',
      'Controlling yourself going down stairs',
      'Any sprint, jump, or sudden change of direction',
      'Protecting the knee ligaments from front-to-back shear',
    ],
    training:
      'Hamstrings cross two joints, so they need both a hip movement and a knee movement. Eccentric strengthening is the standout finding: the Nordic hamstring exercise roughly halves hamstring strain injury rates in team-sport athletes, one of the strongest results in the injury-prevention literature. 6–12 reps.',
    exercises: [
      {
        name: 'Nordic hamstring curl',
        kind: 'isolation',
        equipment: 'Partner or a fixed anchor',
        dose: '2–3 sets × 4–8 reps',
        why: 'The most strongly evidenced hamstring injury-prevention exercise there is. Lower yourself as slowly as you can and push back up with your hands.',
      },
      {
        name: 'Romanian deadlift',
        kind: 'compound',
        equipment: 'Barbell or dumbbells',
        dose: '3–4 sets × 6–10 reps',
        why: 'Loads the hamstrings at long length through the hip. The single best mass builder for the group.',
      },
      {
        name: 'Seated leg curl',
        kind: 'isolation',
        equipment: 'Seated leg curl machine',
        dose: '3–4 sets × 8–12 reps',
        why: 'The seated position keeps the hip flexed, so the hamstrings are already lengthened before the rep starts — which produces more growth than the lying version.',
      },
      {
        name: 'Good morning',
        kind: 'compound',
        equipment: 'Barbell',
        dose: '3 sets × 8–12 reps',
        why: 'A long-lever hip hinge that loads the hamstrings hard with relatively light weight on the bar.',
      },
      {
        name: 'Glute-ham raise',
        kind: 'compound',
        equipment: 'GHD bench',
        dose: '3 sets × 6–10 reps',
        why: 'Trains knee flexion and hip extension in one movement, which is how the hamstring actually works when you run.',
      },
    ],
  },
};

// Which groups appear on which view. A few show on both.
export const FRONT_GROUPS = [
  'traps', 'shoulders', 'chest', 'biceps', 'forearms',
  'abs', 'obliques', 'abductors', 'quads', 'adductors', 'calves',
];

export const BACK_GROUPS = [
  'traps', 'shoulders', 'upper-back', 'lats', 'triceps', 'forearms',
  'lower-back', 'glutes', 'hamstrings', 'calves',
];
