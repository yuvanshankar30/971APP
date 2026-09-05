import traceback
import adsk.core
import adsk.fusion


def AutoArrange(length, width, object_spacing=0.26) -> adsk.fusion.ArrangeFeature:
    app = adsk.core.Application.get()
    ui = app.userInterface
    des: adsk.fusion.Design = app.activeProduct
    comp = des.rootComponent
    arrangeFeats = comp.features.arrangeFeatures

    # Create the input.
    arrangeInput: adsk.fusion.ArrangeFeatureInput = arrangeFeats.createInput(
        adsk.fusion.ArrangeSolverTypes.Arrange2DTrueShapeSolverType
    )

    # Get the definition object from the input.
    arrangeDefInput: adsk.fusion.ArrangeDefinition2DInput = arrangeInput.definition

    # Modify some of the arrange settings.
    arrangeDefInput.globalRotation = (
        adsk.fusion.ArrangeRotationTypes.AllRotationsArrangeRotationType
    )
    arrangeDefInput.isGlobalDirectionFaceUp = False
    arrangeDefInput.isPartInPartAllowed = True
    arrangeDefInput.isCreateCopies = False
    # Get the ArrangeComponents collection from the input objects.
    arrComponents = arrangeInput.arrangeComponents

    # Get the occurrences to arrange.
    occ1 = list(comp.allOccurrences)
    for occ in occ1:
        occ.isGrounded = False
        occ.isGroundToParent = False
        # largestArea = 0
        # for face in occ.bRepBodies.item(0).faces:
        #     if face.area > largestArea:
        #         largestArea = face.area
        #         normal = face.geometry.normal
        # app.log(str(normal.asArray()))
        arrComponents.add(occ)
        # arrcomp.upDirection = adsk.core.Vector3D.create(0, 0, -1)
    # return
    # Define a plane envelope.
    app.log(f"Length: {length}, Width: {width}")
    planeEnv = arrangeInput.setPlaneEnvelope(
        comp.xYConstructionPlane,
        adsk.core.ValueInput.createByString(f"{length} in"),
        adsk.core.ValueInput.createByString(f"{width} in"),
    )

    # Modify some additional properties of the envelope.
    planeEnv.originXOffset = adsk.core.ValueInput.createByString("40 cm")
    planeEnv.originYOffset = adsk.core.ValueInput.createByString("0 cm")
    # Fusion's current API rejects a string here ("Value does not contain a
    # real") even though quantity's own docstring calls a string form valid -
    # a real ValueInput is what this Fusion version actually accepts.
    planeEnv.quantity = adsk.core.ValueInput.createByReal(-1.0)
    planeEnv.objectSpacing = adsk.core.ValueInput.createByString(f"{object_spacing} in")
    # envelopeSpacing is not set here on purpose, not left out by oversight.
    # Per Arrange2DPlaneEnvelopeInput.envelopeSpacing's own docstring, it
    # "defines the spacing between envelopes when there is more than one" -
    # it only means anything when this same plane envelope repeats/tiles
    # ("extension" mode). setPlaneEnvelope was called above with one
    # explicit length and width, producing exactly one fixed-size envelope
    # (one plate) - Fusion calls that a "non-extension environment" and
    # raises RuntimeError 3 ("Cannot set envelope spacing for non-extension
    # environment") the instant this line runs, before arranging anything.
    # frameWidth (below) is the property that actually applies here - the
    # margin from THIS one plate's own edge - and objectSpacing (above)
    # already covers the gap between nested parts within it.
    planeEnv.frameWidth = adsk.core.ValueInput.createByString("0.5 in")

    # Create the arrange feature.
    arrange = arrangeFeats.add(arrangeInput)
    topFace = 0
    bottomFace = 0
    for occ in occ1:
        for face in occ.bRepBodies.item(0).faces:
            try:
                if face.geometry.normal.z > 0.9:
                    topFace += face.area
                if face.geometry.normal.z < -0.9:
                    bottomFace += face.area
            except:
                continue
    if bottomFace > topFace:
        arrange.deleteMe()
        planeEnv.isFlipped = True
        arrange = arrangeFeats.add(arrangeInput)
    return arrange
