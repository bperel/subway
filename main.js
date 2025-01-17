import './style.css'
import * as d3 from 'd3'
import {getTravelTimes, MAX_TIME} from './virtual_rider'
import {journeys, stations} from "interrail";
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration";
import haversine from 'haversine-distance'

dayjs.extend(duration)

const width = 500;
const height = 500;

const svg = d3.select("body").append("svg")
  .attr("viewBox", `0 0 ${width} ${height}`);
const container = svg.append('g');

const tooltip = document.getElementById('tooltip');

const defaultStop = 'Westport';
let homeStationId;

const zoomed = () => {
  container.attr("transform", d3.event.transform);
  container.selectAll('.stop').attr('r', (6.0 / d3.event.transform.k));
  container.selectAll('.home').attr('r', (10.0 / d3.event.transform.k));
};

const zoom = d3.zoom()
  .scaleExtent([0.01, 1])
  .on("zoom", zoomed);
svg.call(zoom);

const maxTravelTime = 140 * 60;
const hourLineSvgSize = 2 * 60 * 60 / maxTravelTime * width;

const createHourCircle = (href) =>
  container.append("image")
    .attr("xlink:href", href)
    .attr("x", (width - hourLineSvgSize) / 2)
    .attr("y", (height - hourLineSvgSize) / 2)
    .attr("width", hourLineSvgSize)
    .attr("height", hourLineSvgSize);


const computeStationPositions = (originStationId, travelTimes) => {
  const originLat = stationsAndPorts[originStationId].lat;
  const originLon = stationsAndPorts[originStationId].lon;

  const positions = {};
  for (const stationId of Object.keys(stationsAndPorts)) {
    const {lat, lon} = stationsAndPorts[stationId];

    const deltaY = lat - originLat;
    const deltaX = (lon - originLon) * 0.767;
    const angle = Math.atan2(deltaY, deltaX) + 30 / 180 * Math.PI;
    const origDist = Math.sqrt(Math.pow(deltaX, 2) + Math.pow(deltaY, 2));

    const dist = travelTimes ? (travelTimes[stationId]) / maxTravelTime : origDist * 5;
    positions[stationId] = {x: Math.cos(angle) * dist, y: Math.sin(angle) * dist};
  }

  return positions;
};

const setStationPositions = (stationPositions) => {
  const xValue = (stationId) => stationPositions[stationId].x;
  const yValue = (stationId) => stationPositions[stationId].y;
  const xScale = d3.scaleLinear().range([0, width]).domain([-1, 1]);
  const yScale = d3.scaleLinear().range([height, 0]).domain([-1, 1]);
  const xMap = (x) => xScale(xValue(x));
  const yMap = (y) => yScale(yValue(y));

  const lineFunc = d3.line().x(xMap).y(yMap).curve(d3.curveNatural);
  const createLine = (subwayLine) => lineFunc(subwayLine.stations);

  container.selectAll('.line').remove()
  const lineSelection = container.selectAll('.line').data(Object.values(lines));

  lineSelection.enter().append('path')
    .attr('class', 'line')
    .attr('name', (l) => l.stations.join('-'))
    .attr('stroke', (l) => l.color)
    .attr('stroke-width', 3)
    .merge(lineSelection)
    .transition()
    .attr('d', createLine)
    .attr('fill', 'none');

  const stopSelection = container.selectAll('.stop').data(Object.keys(stationsAndPorts));
  let merged = stopSelection.enter().append('circle').attr('class', 'stop')
    .attr('stroke', (l) => l.color).attr('r', 6).attr('fill', 'black').merge(stopSelection);
  merged.transition().attr('cx', xMap).attr('cy', yMap);
  addClickHandlers(merged);

  const homeSelection = container.selectAll('.home').data([homeStationId]);
  merged = homeSelection.enter().append('circle').attr('class', 'home').attr('r', 10).attr('fill', 'white').attr('stroke', 'black').attr('stroke-width', 2).merge(homeSelection);
  merged.transition().attr('cx', () => xScale(0)).attr('cy', () => yScale(0));
  addClickHandlers(merged);
};

const getStationDetails = async (stationName) => {
  let key = `station-${stationName}`;
  if (localStorage.getItem(key)) {
    return JSON.parse(localStorage.getItem(key))
  } else {
    const stationResults = await stations.search(stationName, {results: 1})
    const value = {name: stationResults[0].name, id: stationResults[0].id};
    localStorage.setItem(key, JSON.stringify(value))
    return value
  }
}

let journeyStartDate = '2022-09-08T18:00:00+0200';

const getNightTripLeg = (journey) => journey.totalTime < 14 * 3600 && journey.legs.length <= 2 && journey.legs.find(leg => leg.time > 7 * 3600)

const getJourneyDetails = async (stationName1, stationName2) => {
  let key = `journey-starting-${journeyStartDate}-from-${stationName1}-to-${stationName2}`;
  if (localStorage.getItem(key)) {
    return JSON.parse(localStorage.getItem(key))
  } else {
    let value =
      (await journeys(
        (await getStationDetails(stationName1)).id,
        (await getStationDetails(stationName2)).id,
        {when: new Date(journeyStartDate)}
      )).map(journey => ({
        ...journey,
        legs: journey.legs.map(leg => ({
          ...leg,
          time: dayjs.duration(dayjs(leg.arrival).diff(leg.departure)).asSeconds()
        })),
        totalTime: dayjs.duration(dayjs(journey.legs[journey.legs.length - 1].arrival).diff(journey.legs[0].departure)).asSeconds()
      })
    );
    localStorage.setItem(key, JSON.stringify(value))
    return value
  }
}

let travelTimes = null;
const updateMap = async (newHomeStationId) => {
  homeStationId = newHomeStationId
  hourCircleBlank.transition().attr('opacity', 0);
  hourCircle.transition().attr('opacity', 1);

  travelTimes = getTravelTimes(homeStationId, graph, stationsAndPorts)
  const stationPositions = computeStationPositions(homeStationId, travelTimes)
  setStationPositions(stationPositions);
}

let shouldHideTooltip = true;
const addClickHandlers = (selection) =>
  selection
    .on('click', async (newHomeStationId) => {
      const currentStation = stationsAndPorts[newHomeStationId];
      const stationName = currentStation.name
      let detailsElement = document.getElementById('details');
      let stationDetails = await getStationDetails(stationName);
      detailsElement.textContent = 'Selected station: ' + stationDetails.name

      const smallTrip = `${stationName} - ${stationDetails.name}`
      stationsAndPorts[stationDetails.name] = {
        name: stationDetails.name,
        color: 'green',
        lat: stationDetails.lat,
        lon: stationDetails.lon,
      }
      lines[smallTrip] = {
        name: smallTrip,
        stations: [stationName, stationDetails.name],
        color: 'red',
        time: 1800
      }

      const closeCities = Object.values(stationsAndPorts)
        .filter((otherStation) =>
          otherStation.name !== currentStation.name && haversine(currentStation, otherStation) < 1_000_000
        ).map(({name}) => name)

      console.log(stationsAndPorts)
      let firstStation = stationsAndPorts[Object.keys(stationsAndPorts)[0]];
      console.log(`Distance to ${Object.keys(stationsAndPorts)[0]}: ${haversine(currentStation, firstStation)}`);

      console.log('Close cities: ' + JSON.stringify(closeCities))
      for (const closeCity of closeCities) {
        await getStationDetails(closeCity)
        const journeyResults = await getJourneyDetails(stationName, closeCity);
        const nightTripLeg = journeyResults.find(journey => getNightTripLeg(journey))
        if (nightTripLeg) {
          console.log(`${closeCity}: The journey is suitable for a night trip`)
          for (const leg of nightTripLeg.legs) {
            for (const side of ['origin', 'destination']) {
              if (!Object.keys(stationsAndPorts).includes(leg[side].name)) {
                stationsAndPorts[leg[side].name] = {
                  name: leg[side].name,
                  color: 'red',
                  lat: leg[side].location.latitude,
                  lon: leg[side].location.longitude,
                }
              }
            }
            let name = `${leg.origin.name} - ${leg.destination.name}`;
            lines[name] = {
              name,
              stations: [leg.origin.name, leg.destination.name],
              color: 'green',
              time: dayjs.duration(dayjs(leg.arrival).diff(leg.departure)).asSeconds()
            }
          }
          // for (const [key, line] of Object.entries(lines)) {
          //   if ([`${stationName} - ${closeCity}`, `${closeCity} - ${stationName}`].includes(line.name)) {
          //     console.log(`The night trip leg will be to ${closeCity})`)
          //     lines[key].timeReal = nightTripLeg.totalTime
          //     lines[key].color = "green"
          //   }
          // }
          console.log(nightTripLeg)
        }
      }
      await calculateGraph(newHomeStationId)
      return updateMap(newHomeStationId);
    })
    .on('mouseenter', (d) => {
      shouldHideTooltip = false;
      tooltip.style.top = `${d3.event.pageY + 10}px`
      tooltip.style.left = `${d3.event.pageX + 10}px`
      tooltip.style.display = 'block';
      let innerHTML = `<strong>${stationsAndPorts[d].name}</strong><br/>`;
      let minutesAway = (travelTimes[d] / 60 | 0);
      if (minutesAway === MAX_TIME / 60) {
        tooltip.innerHTML = `${innerHTML} Very far away`;
        return
      }
      const hoursAway = Math.floor(minutesAway / 60);
      minutesAway -= hoursAway * 60
      if (hoursAway) {
        innerHTML += `${hoursAway} hours `
      }
      if (minutesAway) {
        innerHTML += `${minutesAway} minutes `
      }
      tooltip.innerHTML = `${innerHTML} ${hoursAway || minutesAway ? 'away' : ''}`;
    }).on('mouseleave', () => {
    shouldHideTooltip = true;
    setTimeout(() => {
      if (shouldHideTooltip) {
        tooltip.style.display = 'none';
      }
    }, 100);
  });

const hourCircleBlank = createHourCircle('TwoHoursWithoutLabel.svg');
const hourCircle = createHourCircle('TwoHours.svg').attr('opacity', 0);

let stationsAndPorts = {}
let lines = {}
let graph

const addStation = ({name, coordinates, type}) => {
  stationsAndPorts[name] = {
    name,
    color: type === 'Station' ? 'red' : 'blue',
    ...coordinates
  }
}

const addLine = ({description, name, type, coordinates}) => {
  if (!description) {
    return
  }
  name = name.replace(/Hilsinki/, 'Helsinki')
  name = name.replace(/Carania/, 'Catania')
  name = name.replace(/Sevilla/, 'Seville')
  name = name.replace(/Warzaw/, 'Warsaw')
  name = name.replace(/Klaipèda/u, 'Klaipėda')
  name = name.replace(/Gdansk/, 'Gdańsk')

  const lineStations = name.split(' - ');
  lines[name] = {
    name,
    coordinates,
    stations: lineStations,
    color: type === 'Routes (train)' ? 'red' : 'blue',
    time: description.match(/(\d+)hr(?: (\d+) *min)?/).reduce(
      (acc, value, idx) =>
        acc + (idx && value ? parseInt(value) * Math.pow(60, (1 + (2 - idx))) : 0),
      0
    )
  }

  for (const [idx, stationName] of Object.entries(lineStations)) {
    if (!lineStations[stationName]) {
      addStation({
        name: stationName,
        coordinates: coordinates[idx],
        type: type === 'Routes (train)' ? 'Station' : 'Port'
      })
    }
  }
}

const calculateGraph = async (newHomeStationId) => {
  console.log(lines)
  graph = Object.values(lines).reduce((acc, {stations: [station1, station2], time, timeReal}) => ({
    ...acc,
    [station1]: {...(acc[[station1]] || {}), [station2]: (timeReal || time)}
  }), {})
  for (const [station1, stations2] of Object.entries(graph)) {
    for (const [station2, time] of Object.entries(stations2)) {
      if (!graph[station2]) {
        graph[station2] = {}
      }
      if (!graph[station2][station1]) {
        graph[station2][station1] = time
      }
    }
  }
  await updateMap(newHomeStationId || defaultStop);
};

d3.xml('doc.kml', async (output) => {
  [...output.documentElement.getElementsByTagName("Placemark")]
    .forEach((element) => {
      const type = element.parentElement.getElementsByTagName('name')[0].textContent;
      if (!/^Route/.test(type)) {
        return
      }
      const description = (element.getElementsByTagName('description')[0] || {textContent: null}).textContent
      let name = element.getElementsByTagName('name')[0].textContent;
      const coordinates = element.getElementsByTagName('coordinates')[0].textContent.trim().split(/[ \n]+/)
        .map(coordinates => coordinates.split(',')
          .filter((_, idx) => idx < 2)
          .reduce(
            (acc, coordinate, idx) => ({
              ...acc,
              [idx === 0 ? 'lon' : 'lat']: coordinate
            }),
            {})
        );
      addLine({description, name, coordinates, type})
    })

  await calculateGraph();
})
